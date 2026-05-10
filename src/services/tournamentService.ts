import { supabaseAdmin } from '../lib/supabase';

// =========================================
// Bracket Generation for Knockout Format
// =========================================

/**
 * Generates a single-elimination bracket for a knockout tournament.
 * Handles byes automatically when participant count is not a power of 2.
 *
 * @param tournamentId - The tournament UUID
 * @param participantIds - Array of participant UUIDs (from tournament_participants)
 * @returns The created matches
 */
export async function generateKnockoutBracket(tournamentId: string, participantIds: string[], phase: 'KNOCKOUT' = 'KNOCKOUT') {
    const count = participantIds.length;
    if (count < 2) {
        throw new Error('At least 2 participants are required for a knockout tournament');
    }

    // Find next power of 2 to determine bracket size
    const bracketSize = nextPowerOf2(count);
    const totalRounds = Math.log2(bracketSize);
    const byeCount = bracketSize - count;

    // Seed participants (simple sequential seeding)
    // Byes are placed at the end, meaning top-seeded players get automatic advancement
    const slots: (string | null)[] = [...participantIds];
    for (let i = 0; i < byeCount; i++) {
        slots.push(null); // null = BYE
    }

    // Build all matches round by round (from first round to finals)
    const allMatches: any[] = [];

    // Round 1 matches
    const round1MatchCount = bracketSize / 2;
    for (let i = 0; i < round1MatchCount; i++) {
        const p1 = slots[i * 2] || null;
        const p2 = slots[i * 2 + 1] || null;

        // If one side is a bye, the other automatically wins
        let winnerId: string | null = null;
        let status = 'PENDING';

        if (p1 && !p2) {
            winnerId = p1;
            status = 'COMPLETED';
        } else if (!p1 && p2) {
            winnerId = p2;
            status = 'COMPLETED';
        } else if (!p1 && !p2) {
            winnerId = null; // Double BYE slot moves up
            status = 'COMPLETED';
        }

        allMatches.push({
            tournament_id: tournamentId,
            round_number: 1,
            match_number: i + 1,
            participant1_id: p1,
            participant2_id: p2,
            winner_id: winnerId,
            status: status,
            phase: phase
        });
    }

    // Create subsequent round placeholders
    for (let round = 2; round <= totalRounds; round++) {
        const matchCount = bracketSize / Math.pow(2, round);
        for (let i = 0; i < matchCount; i++) {
            allMatches.push({
                tournament_id: tournamentId,
                round_number: round,
                match_number: i + 1,
                participant1_id: null,
                participant2_id: null,
                winner_id: null,
                status: 'PENDING',
                phase: phase
            });
        }
    }

    // Insert all matches
    const { data: insertedMatches, error: insertError } = await supabaseAdmin
        .from('gym_tournament_matches')
        .insert(allMatches)
        .select()
        .order('round_number', { ascending: true })
        .order('match_number', { ascending: true });

    if (insertError) throw insertError;

    // Now link matches to their next_match_id
    // For each match in round R at position M, the winner goes to round R+1 at position ceil(M/2)
    const matchMap = new Map<string, any>();
    for (const m of insertedMatches!) {
        matchMap.set(`${m.round_number}-${m.match_number}`, m);
    }

    const updatePromises = [];
    for (const match of insertedMatches!) {
        if (match.round_number < totalRounds) {
            const nextRound = match.round_number + 1;
            const nextMatchNum = Math.ceil(match.match_number / 2);
            const nextMatch = matchMap.get(`${nextRound}-${nextMatchNum}`);

            if (nextMatch) {
                updatePromises.push(
                    supabaseAdmin
                        .from('gym_tournament_matches')
                        .update({ next_match_id: nextMatch.id })
                        .eq('id', match.id)
                );
            }
        }
    }
    await Promise.all(updatePromises);

    // IMPORTANT: Fetch the matches AGAIN from the DB to get the updated next_match_id
    const { data: updatedMatches } = await supabaseAdmin
        .from('gym_tournament_matches')
        .select('*')
        .eq('tournament_id', tournamentId)
        .eq('phase', phase);

    // Auto-advance winners/byes to the next round recursively
    for (const match of updatedMatches || []) {
        if (match.status === 'COMPLETED') {
            await advanceWinner(match);
        }
    }

    return insertedMatches;
}

/**
 * Advances a winner to the next match slot in the bracket.
 */
async function advanceWinner(
    currentMatch: any,
    matchMap?: Map<string, any>,
    totalRounds?: number
) {
    if (!currentMatch.next_match_id) {
        // If this is the finals, we are done
        if (currentMatch.phase === 'KNOCKOUT' && currentMatch.status === 'COMPLETED') {
            await supabaseAdmin
                .from('gym_tournaments')
                .update({
                    winner_participant_id: currentMatch.winner_id,
                    status: 'COMPLETED',
                    updated_at: new Date().toISOString(),
                })
                .eq('id', currentMatch.tournament_id);
        }
        return;
    }

    // 1. Get the next match and the sibling match
    // Sibling is the match that feeds into the same next match slot
    const isOdd = currentMatch.match_number % 2 !== 0;
    const siblingMatchNum = isOdd ? currentMatch.match_number + 1 : currentMatch.match_number - 1;

    // Fetch from DB to be sure of latest state (especially when not using matchMap)
    const { data: sibling } = await supabaseAdmin
        .from('gym_tournament_matches')
        .select('*')
        .eq('tournament_id', currentMatch.tournament_id)
        .eq('phase', currentMatch.phase)
        .eq('group_label', currentMatch.group_label)
        .eq('round_number', currentMatch.round_number)
        .eq('match_number', siblingMatchNum)
        .single();

    // 2. Update the slot in the next match
    const updateField = isOdd ? 'participant1_id' : 'participant2_id';

    const { data: nextMatch, error: nError } = await supabaseAdmin
        .from('gym_tournament_matches')
        .update({ [updateField]: currentMatch.winner_id })
        .eq('id', currentMatch.next_match_id)
        .select()
        .single();

    if (nError || !nextMatch) return;

    // 3. RECURSIVE CHECK: Can we auto-complete the next match?
    // This ONLY happens if BOTH children of the next match are COMPLETED.
    // currentMatch is one child, sibling is the other.
    if (sibling && sibling.status === 'COMPLETED' && nextMatch.status === 'PENDING') {
        let autoWinnerId: string | null | undefined = undefined;

        const w1 = isOdd ? currentMatch.winner_id : sibling.winner_id;
        const w2 = isOdd ? sibling.winner_id : currentMatch.winner_id;

        // Determine winner: 
        // - If one side has a player and other is a Bye (null winner), player moves up.
        // - If both are Byes (both null winners), an empty slot moves up.
        // - If BOTH have players, we DO NOT auto-advance (wait for manual result).

        if (w1 && !w2) {
            autoWinnerId = w1;
        } else if (!w1 && w2) {
            autoWinnerId = w2;
        } else if (!w1 && !w2) {
            autoWinnerId = null; // Double-Bye slot moves forward
        }

        if (autoWinnerId !== undefined) {
            const { data: completedNext } = await supabaseAdmin
                .from('gym_tournament_matches')
                .update({
                    winner_id: autoWinnerId,
                    status: 'COMPLETED'
                })
                .eq('id', nextMatch.id)
                .select()
                .single();

            if (completedNext) {
                // Keep moving up!
                await advanceWinner(completedNext);
            }
        }
    }
}

// =========================================
// Multi-Stage Generation (Groups + Knockout)
// =========================================

/**
 * Generates a two-phase tournament structure:
 * Phase 1: Group Stage (Round Robin)
 * Phase 2: Knockout Stage (Placeholder)
 */
export async function generateMultiStageStructure(
    tournamentId: string,
    participantIds: string[]
) {
    // Shuffling participants for fair, randomized group placement
    const shuffledIds = [...participantIds].sort(() => Math.random() - 0.5);
    const totalParticipants = shuffledIds.length;

    // 0. Fetch group size from tournament rules
    const { data: tournament } = await supabaseAdmin
        .from('gym_tournaments')
        .select('rules')
        .eq('id', tournamentId)
        .single();

    const targetGroupSize = tournament?.rules?.group_size || 4;

    // Respect the user's target group size exactly.
    // For 40 participants / size 8 = exactly 5 groups.
    let groupCount = Math.ceil(totalParticipants / targetGroupSize);

    // Sanity checks
    if (groupCount < 1) groupCount = 1;
    if (groupCount > totalParticipants) groupCount = totalParticipants;

    const groups: string[][] = Array.from({ length: groupCount }, () => []);

    // Switch to numbered labels (Group 1, Group 2...) since we might have more than 26 groups
    const groupLabels = Array.from({ length: groupCount }, (_, i) => `Group ${i + 1}`);

    // 1. Assign participants to groups in DB and memory
    const groupAssignments = [];
    for (let i = 0; i < totalParticipants; i++) {
        const groupIndex = i % groupCount;
        const participantId = shuffledIds[i];
        groups[groupIndex].push(participantId);

        groupAssignments.push(
            supabaseAdmin
                .from('gym_tournament_participants')
                .update({ group_label: `Group ${groupLabels[groupIndex]}` })
                .eq('id', participantId)
        );
    }
    await Promise.all(groupAssignments);

    const allMatches: any[] = [];

    // 2. Generate matches for each group
    const matchesPerPlayer = tournament?.rules?.matches_per_player || targetGroupSize - 1;

    for (let g = 0; g < groupCount; g++) {
        const groupPlayers = [...groups[g]];
        const label = `Group ${g + 1}`;

        if (groupPlayers.length < 2) continue;

        // Circular Tournament Scheduling Algorithm (for fair match distribution)
        // If odd number of players, add a dummy 'BYE'
        if (groupPlayers.length % 2 !== 0) groupPlayers.push(null as any);

        const n = groupPlayers.length;
        const totalRounds = n - 1;
        const roundsToGenerate = Math.min(matchesPerPlayer, totalRounds);
        const rotation = [...groupPlayers];

        for (let round = 1; round <= roundsToGenerate; round++) {
            for (let i = 0; i < n / 2; i++) {
                const p1 = rotation[i];
                const p2 = rotation[n - 1 - i];

                if (p1 && p2) {
                    allMatches.push({
                        tournament_id: tournamentId,
                        phase: 'GROUP',
                        group_label: label,
                        round_number: round,
                        match_number: i + 1,
                        participant1_id: p1,
                        participant2_id: p2,
                        status: 'PENDING'
                    });
                }
            }
            // Rotate the array (keep index 0 fixed)
            rotation.splice(1, 0, rotation.pop()!);
        }
    }

    // 3. Insert Group Phase matches
    const { data: insertedMatches, error } = await supabaseAdmin
        .from('gym_tournament_matches')
        .insert(allMatches)
        .select('*');

    if (error) throw error;

    return insertedMatches;
}

// =========================================
// Attempt Generation for Score / Time Based
// =========================================

/**
 * Pre-generates attempt rows for all participants in a score-based or time-based tournament.
 *
 * @param tournamentId - The tournament UUID
 * @param participantIds - Array of participant UUIDs
 * @param attemptCount - Number of attempts per participant (from rules)
 */
export async function generateAttempts(
    tournamentId: string,
    participantIds: string[],
    attemptCount: number
) {
    const rows: any[] = [];

    for (const participantId of participantIds) {
        for (let attempt = 1; attempt <= attemptCount; attempt++) {
            rows.push({
                tournament_id: tournamentId,
                participant_id: participantId,
                attempt_number: attempt,
                score: null,
                status: 'PENDING',
            });
        }
    }

    const { data, error } = await supabaseAdmin
        .from('gym_tournament_attempts')
        .insert(rows)
        .select();

    if (error) throw error;
    return data;
}

// =========================================
// Leaderboard Calculation
// =========================================

/**
 * Calculates the leaderboard for a score-based or time-based tournament.
 * - Score-Based: Rank by highest best valid score
 * - Time-Based: Rank by measurement rule (longest time = best for plank, fastest = best for sprint)
 *
 * @returns Sorted leaderboard array
 */
export async function calculateLeaderboard(tournamentId: string) {
    // Get tournament details for format type
    const { data: tournament, error: tError } = await supabaseAdmin
        .from('gym_tournaments')
        .select(`
            *,
            format:format_id(id, name, type)
        `)
        .eq('id', tournamentId)
        .single();

    if (tError || !tournament) throw new Error('Tournament not found');

    const formatType = (tournament.format as any)?.type;

    // Get all valid attempts with participant + member info
    const { data: attempts, error: aError } = await supabaseAdmin
        .from('gym_tournament_attempts')
        .select(`
            *,
            participant:participant_id(
                id,
                external_name,
                member:member_id(id, full_name)
            )
        `)
        .eq('tournament_id', tournamentId)
        .eq('status', 'VALID')
        .order('score', { ascending: false });

    if (aError) throw aError;

    // Group attempts by participant
    const participantBest = new Map<string, { participantId: string; memberName: string; bestScore: number; attempts: any[] }>();

    for (const attempt of attempts || []) {
        const pid = attempt.participant_id;
        const memberName = (attempt.participant as any)?.external_name || (attempt.participant as any)?.member?.full_name || 'Unknown';

        if (!participantBest.has(pid)) {
            participantBest.set(pid, {
                participantId: pid,
                memberName,
                bestScore: attempt.score ?? 0,
                attempts: [],
            });
        }

        const entry = participantBest.get(pid)!;
        entry.attempts.push({
            attemptNumber: attempt.attempt_number,
            score: attempt.score,
            status: attempt.status,
        });

        // Update best score
        if (formatType === 'TIME_BASED') {
            // For time-based: higher duration = better (e.g., plank hold)
            // The rules.measurement field can control this, but default is "longest wins"
            if ((attempt.score ?? 0) > entry.bestScore) {
                entry.bestScore = attempt.score ?? 0;
            }
        } else {
            // Score-based: highest value wins
            if ((attempt.score ?? 0) > entry.bestScore) {
                entry.bestScore = attempt.score ?? 0;
            }
        }
    }

    // Sort by best score descending (highest first for both score and time-based by default)
    const leaderboard = Array.from(participantBest.values())
        .sort((a, b) => b.bestScore - a.bestScore)
        .map((entry, index) => ({
            rank: index + 1,
            ...entry,
        }));

    return leaderboard;
}

// =========================================
// Match Result & Auto-Advance (Knockout)
// =========================================

/**
 * Records the result of a knockout match and advances the winner to the next round.
 */
export async function recordMatchResult(
    matchId: string,
    winnerId: string,
    p1Score?: number,
    p2Score?: number
) {
    // Get current match details
    const { data: match, error: mError } = await supabaseAdmin
        .from('gym_tournament_matches')
        .select('*, next_match:next_match_id(*)')
        .eq('id', matchId)
        .single();

    if (mError || !match) throw new Error('Match not found');
    if (match.status === 'COMPLETED') throw new Error('Match already completed');

    // Validate winner is one of the participants
    if (winnerId !== match.participant1_id && winnerId !== match.participant2_id) {
        throw new Error('Winner must be one of the match participants');
    }

    // Update match result
    const { data: updatedMatch, error: updateError } = await supabaseAdmin
        .from('gym_tournament_matches')
        .update({
            winner_id: winnerId,
            participant1_score: p1Score ?? null,
            participant2_score: p2Score ?? null,
            status: 'COMPLETED',
            updated_at: new Date().toISOString(),
        })
        .eq('id', matchId)
        .select()
        .single();

    if (updateError) throw updateError;

    // Auto-advance winner to next match if exists
    if (updatedMatch) {
        await advanceWinner(updatedMatch);
    }

    return { success: true, winnerId };
}

/**
 * Finalizes the group stage and generates the knockout bracket based on winners.
 * If ties are detected that prevent determining the top players, returns tie details.
 */
export async function advanceToKnockout(tournamentId: string) {
    // 1. Get all group stage matches and participants
    const { data: matches, error: mError } = await supabaseAdmin
        .from('gym_tournament_matches')
        .select(`
            *,
            participant1:participant1_id(id, external_name, member:member_id(id, full_name)),
            participant2:participant2_id(id, external_name, member:member_id(id, full_name))
        `)
        .eq('tournament_id', tournamentId)
        .in('phase', ['GROUP', 'TIE_BREAKER']);

    if (mError) throw mError;

    // 2. Calculate wins per participant in each group
    const standings = new Map<string, { [participantId: string]: { wins: number; name: string } }>();
    matches.forEach(m => {
        if (m.winner_id && m.group_label) {
            const group = m.group_label;
            if (!standings.has(group)) standings.set(group, {});
            const groupStandings = standings.get(group)!;
            
            if (!groupStandings[m.winner_id]) {
                const p = m.participant1_id === m.winner_id ? m.participant1 : m.participant2;
                groupStandings[m.winner_id] = { 
                    wins: 0, 
                    name: (p as any)?.external_name || (p as any)?.member?.full_name || 'Unknown' 
                };
            }
            groupStandings[m.winner_id].wins += 1;
        }
    });

    // 3. Identify winners for each group and check for ties
    const winners: string[] = [];
    const groupLabels = Array.from(standings.keys()).sort((a, b) => {
        const numA = parseInt(a.replace(/^\D+/g, '')) || a.charCodeAt(0);
        const numB = parseInt(b.replace(/^\D+/g, '')) || b.charCodeAt(0);
        return numA - numB;
    });

    const playersToAdvance = groupLabels.length === 32 ? 1 : 2;

    for (const label of groupLabels) {
        const groupStandings = standings.get(label)!;
        const sortedEntries = Object.entries(groupStandings)
            .sort(([, a], [, b]) => b.wins - a.wins);

        // Check for tie at the cutoff point
        // If we need 2, and 2nd and 3rd have same wins, it's a tie
        if (sortedEntries.length > playersToAdvance) {
            const lastAdvancingWins = sortedEntries[playersToAdvance - 1][1].wins;
            const firstExcludedWins = sortedEntries[playersToAdvance][1].wins;

            if (lastAdvancingWins === firstExcludedWins) {
                // Find all players tied with the cutoff
                const tiedPlayers = sortedEntries
                    .filter(([, p]) => p.wins === lastAdvancingWins)
                    .map(([id, p]) => ({ id, name: p.name }));
                
                // If it's a 3-way tie (or more) that affects the top positions
                return {
                    tieDetected: true,
                    groupLabel: label,
                    tiedPlayers,
                    playersToAdvance
                };
            }
        }

        winners.push(...sortedEntries.slice(0, playersToAdvance).map(([id]) => id));
    }

    if (winners.length < 2) {
        throw new Error('Not enough group winners recorded to start knockout bracket.');
    }

    // 4. Generate the knockout bracket using these winners
    const bracket = await generateKnockoutBracket(tournamentId, winners, 'KNOCKOUT');
    return { success: true, bracket };
}

/**
 * Generates tie-breaker matches for a specific group.
 * strategy: 'STEPLADDER' (2 matches) or 'MINI_LEAGUE' (3 matches for a 3rd way tie)
 */
export async function generateTieBreakerMatches(
    tournamentId: string,
    groupLabel: string,
    participantIds: string[],
    strategy: 'STEPLADDER' | 'MINI_LEAGUE'
) {
    const matches: any[] = [];
    
    // 1. Find the next round number for tie-breakers in this group
    const { data: existingMatches } = await supabaseAdmin
        .from('gym_tournament_matches')
        .select('round_number')
        .eq('tournament_id', tournamentId)
        .eq('phase', 'TIE_BREAKER')
        .eq('group_label', groupLabel)
        .order('round_number', { ascending: false })
        .limit(1);

    const nextRound = (existingMatches?.[0]?.round_number || 0) + 1;

    if (strategy === 'STEPLADDER') {
        // Randomly pick 2 to play first
        const shuffled = [...participantIds].sort(() => Math.random() - 0.5);
        const p1 = shuffled[0];
        const p2 = shuffled[1];
        const p3 = shuffled[2]; // The 3rd player who waits

        // 2. Create Match 2 first (The Final Tie-Breaker Match)
        const { data: m2, error: e2 } = await supabaseAdmin
            .from('gym_tournament_matches')
            .insert({
                tournament_id: tournamentId,
                phase: 'TIE_BREAKER',
                group_label: groupLabel,
                round_number: nextRound,
                match_number: 2,
                participant2_id: p3, // P3 waits in the second slot
                status: 'PENDING'
            })
            .select()
            .single();

        if (e2) throw e2;

        // 3. Create Match 1 and link to Match 2
        const { data: m1, error: e1 } = await supabaseAdmin
            .from('gym_tournament_matches')
            .insert({
                tournament_id: tournamentId,
                phase: 'TIE_BREAKER',
                group_label: groupLabel,
                round_number: nextRound,
                match_number: 1,
                participant1_id: p1,
                participant2_id: p2,
                next_match_id: m2.id,
                status: 'PENDING'
            })
            .select()
            .single();

        if (e1) throw e1;
        
        return [m1, m2];
    } else {
        // MINI_LEAGUE: A vs B, B vs C, C vs A
        for (let i = 0; i < participantIds.length; i++) {
            for (let j = i + 1; j < participantIds.length; j++) {
                matches.push({
                    tournament_id: tournamentId,
                    phase: 'TIE_BREAKER',
                    group_label: groupLabel,
                    round_number: nextRound,
                    match_number: matches.length + 1,
                    participant1_id: participantIds[i],
                    participant2_id: participantIds[j],
                    status: 'PENDING'
                });
            }
        }

        const { data, error } = await supabaseAdmin
            .from('gym_tournament_matches')
            .insert(matches)
            .select();

        if (error) throw error;
        return data;
    }
}

// =========================================
// Utility
// =========================================

function nextPowerOf2(n: number): number {
    let p = 1;
    while (p < n) p *= 2;
    return p;
}
