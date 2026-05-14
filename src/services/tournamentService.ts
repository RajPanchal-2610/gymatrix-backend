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
    const shuffledIds = [...participantIds];
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

    const winningCriteria = (tournament.rules as any)?.winning_criteria || (formatType === 'TIME_BASED' ? 'lowest' : 'highest');

    // Group attempts by participant
    const participantBest = new Map<string, { participantId: string; memberName: string; bestScore: number; attempts: any[] }>();

    for (const attempt of attempts || []) {
        const pid = attempt.participant_id;
        const memberName = (attempt.participant as any)?.external_name || (attempt.participant as any)?.member?.full_name || 'Unknown';
        const score = attempt.score ?? (winningCriteria === 'lowest' ? Infinity : 0);

        if (!participantBest.has(pid)) {
            participantBest.set(pid, {
                participantId: pid,
                memberName,
                bestScore: score,
                attempts: [],
            });
        }

        const entry = participantBest.get(pid)!;
        entry.attempts.push({
            attemptNumber: attempt.attempt_number,
            score: attempt.score,
            status: attempt.status,
        });

        // Update best score based on criteria
        if (winningCriteria === 'lowest') {
            if (score < entry.bestScore) {
                entry.bestScore = score;
            }
        } else {
            if (score > entry.bestScore) {
                entry.bestScore = score;
            }
        }
    }

    // Sort by best score (ascending for lowest-wins, descending for highest-wins)
    const leaderboard = Array.from(participantBest.values())
        .sort((a, b) => {
            if (winningCriteria === 'lowest') return a.bestScore - b.bestScore;
            return b.bestScore - a.bestScore;
        })
        .map((entry, index) => ({
            rank: index + 1,
            ...entry,
            // Clean up Infinity if no scores were recorded
            bestScore: entry.bestScore === Infinity ? 0 : entry.bestScore
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
    // 0. Get tournament format to know if high score or low time is better
    const { data: tournament } = await supabaseAdmin
        .from('gym_tournaments')
        .select('format:format_id(type)')
        .eq('id', tournamentId)
        .single();

    const isTimeBased = (tournament?.format as any)?.type === 'TIME_BASED';

    // 1. Get all matches for the tournament
    const { data: matches, error: mError } = await supabaseAdmin
        .from('gym_tournament_matches')
        .select(`
            *,
            participant1:participant1_id(id, external_name, member:member_id(full_name)),
            participant2:participant2_id(id, external_name, member:member_id(full_name))
        `)
        .eq('tournament_id', tournamentId);

    if (mError) throw mError;
    if (!matches) return { success: false, error: 'No matches found' };

    // 2. Calculate wins, total score, and tie-breaker priority per participant
    const standings = new Map<string, { [participantId: string]: { wins: number; name: string; total_score: number; tie_breaker_score: number; played_tie_breaker: boolean } }>();
    matches.forEach((m: any) => {
        const group = m.group_label;
        if (!group) return;
        if (!standings.has(group)) standings.set(group, {});
        const groupStandings = standings.get(group)!;

        // Ensure all participants in the match are in the map
        [m.participant1_id, m.participant2_id].forEach(pid => {
            if (pid && !groupStandings[pid]) {
                const p = m.participant1_id === pid ? m.participant1 : m.participant2;
                groupStandings[pid] = {
                    wins: 0,
                    name: (p as any)?.external_name || (p as any)?.member?.full_name || 'Unknown',
                    total_score: 0,
                    tie_breaker_score: 0,
                    played_tie_breaker: false
                };
            }
        });

        // Add scores to totals (if they exist)
        if (m.participant1_id && m.participant1_score !== null) {
            groupStandings[m.participant1_id].total_score += Number(m.participant1_score);
        }
        if (m.participant2_id && m.participant2_score !== null) {
            groupStandings[m.participant2_id].total_score += Number(m.participant2_score);
        }

        if (m.phase === 'TIE_BREAKER') {
            if (m.participant1_id) groupStandings[m.participant1_id].played_tie_breaker = true;
            if (m.participant2_id) groupStandings[m.participant2_id].played_tie_breaker = true;
        }

        if (m.winner_id && m.status === 'COMPLETED') {
            groupStandings[m.winner_id].wins += 1;
        }

        if (m.phase === 'TIE_BREAKER' && m.status === 'COMPLETED') {
            const roundMatches = matches.filter(other => 
                other.phase === 'TIE_BREAKER' && 
                other.group_label === m.group_label &&
                other.round_number === m.round_number
            );
            
            // A Mini League has no linked matches. A Stepladder always has links 
            // (unless it's a 1-match tiebreaker, which functions properly as Stepladder anyway).
            const hasNextMatch = roundMatches.some(other => other.next_match_id !== null);
            const isMiniLeague = roundMatches.length > 1 && !hasNextMatch;
            const isStepladder = !isMiniLeague;

            if (isStepladder) {
                if (m.winner_id && groupStandings[m.winner_id]) {
                    groupStandings[m.winner_id].tie_breaker_score += (m.match_number * 10);
                }
                const loserId = m.winner_id === m.participant1_id ? m.participant2_id : m.participant1_id;
                if (loserId && groupStandings[loserId]) {
                    groupStandings[loserId].tie_breaker_score += m.match_number;
                }
            }
        }
    });

    // 2.5 Handle "Safe" players who were in the tie but didn't have to play in the LATEST round
    // They should be ranked above losers but below winners of tie-breaker matches in that specific round.
    standings.forEach((groupStandings, label) => {
        // Find the latest tie-breaker round for this group
        const latestRound = matches.reduce((max, m) => 
            (m.phase === 'TIE_BREAKER' && m.group_label === label) ? Math.max(max, m.round_number) : max, 
            0
        );

        if (latestRound > 0) {
            Object.keys(groupStandings).forEach(pid => {
                const p = groupStandings[pid];
                // Check if they played in the LATEST round specifically
                const playedInLatest = matches.some(m => 
                    m.phase === 'TIE_BREAKER' && 
                    m.group_label === label && 
                    m.round_number === latestRound &&
                    (m.participant1_id === pid || m.participant2_id === pid)
                );

                if (!playedInLatest) {
                    // Only give safe points to people who WERE tied (wins/score equal to the top players)
                    // but didn't play in the latest round.
                    p.tie_breaker_score = 5; 
                }
            });
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
            .sort(([, a], [, b]) => {
                // 1. Primary: Total Wins (Highest first)
                if (b.wins !== a.wins) return b.wins - a.wins;

                // 2. Secondary: Total Score (Format dependent)
                if (a.total_score !== b.total_score) {
                    return isTimeBased
                        ? a.total_score - b.total_score // Lower time is better
                        : b.total_score - a.total_score; // Higher reps/weight is better
                }

                // 3. Tertiary: Tie-breaker score (from manual tie-breaker matches)
                return b.tie_breaker_score - a.tie_breaker_score;
            });

        // Check for tie at the cutoff point
        if (sortedEntries.length > playersToAdvance) {
            const lastAdvancing = sortedEntries[playersToAdvance - 1][1];
            const firstExcluded = sortedEntries[playersToAdvance][1];

            // A tie only exists if ALL metrics are identical
            const isTie = lastAdvancing.wins === firstExcluded.wins &&
                lastAdvancing.total_score === firstExcluded.total_score &&
                lastAdvancing.tie_breaker_score === firstExcluded.tie_breaker_score;

            if (isTie) {
                // Find all players tied with the cutoff based on all metrics
                const tiedPlayers = sortedEntries
                    .filter(([, p]) =>
                        p.wins === lastAdvancing.wins &&
                        p.total_score === lastAdvancing.total_score &&
                        p.tie_breaker_score === lastAdvancing.tie_breaker_score
                    )
                    .map(([id, p]) => ({ id, name: p.name }));

                // Calculate how many spots the tied players are fighting for
                const firstTiedIndex = sortedEntries.findIndex(([, p]) => 
                    p.wins === lastAdvancing.wins &&
                    p.total_score === lastAdvancing.total_score &&
                    p.tie_breaker_score === lastAdvancing.tie_breaker_score
                );
                const spotsAvailable = playersToAdvance - firstTiedIndex;

                return {
                    tieDetected: true,
                    groupLabel: label,
                    tiedPlayers,
                    playersToAdvance,
                    spotsAvailable
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
    strategy: 'STEPLADDER' | 'MINI_LEAGUE',
    safeParticipantId?: string,
    spotsAvailable: number = 1
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
        const shuffled = [...participantIds].sort(() => Math.random() - 0.5);
        const spots = Math.max(1, spotsAvailable);
        const pools: string[][] = Array.from({ length: spots }, () => []);

        let playersToDistribute = [...shuffled];

        // If exactly 1 safe player is selected and we have 2 spots,
        // we can force them into a pool by themselves so they get a BYE.
        if (spots === 2 && safeParticipantId && participantIds.includes(safeParticipantId)) {
            pools[0].push(safeParticipantId);
            playersToDistribute = playersToDistribute.filter(id => id !== safeParticipantId);
            playersToDistribute.forEach(id => pools[1].push(id));
        } else {
            // Distribute players evenly into the available spot pools
            for (let i = 0; i < playersToDistribute.length; i++) {
                pools[i % spots].push(playersToDistribute[i]);
            }
        }

        let currentMatchNumber = 1;

        for (const pool of pools) {
            if (pool.length < 2) continue; // No matches needed for a pool of 1 (automatic BYE)

            const poolMatches = [];
            // For N players, we need N-1 matches to find 1 winner
            for (let i = 0; i < pool.length - 1; i++) {
                const isFirstMatch = i === 0;
                
                poolMatches.push({
                    tournament_id: tournamentId,
                    phase: 'TIE_BREAKER',
                    group_label: groupLabel,
                    round_number: nextRound,
                    match_number: currentMatchNumber++,
                    participant1_id: isFirstMatch ? pool[0] : null,
                    participant2_id: pool[i + 1],
                    next_match_id: null,
                    status: 'PENDING'
                });
            }

            // Insert matches for this pool
            const { data: inserted, error } = await supabaseAdmin
                .from('gym_tournament_matches')
                .insert(poolMatches)
                .select()
                .order('match_number', { ascending: true });

            if (error) throw error;

            // Link the matches together (Match 1 winner goes to Match 2, etc.)
            if (inserted && inserted.length > 1) {
                for (let i = 0; i < inserted.length - 1; i++) {
                    await supabaseAdmin
                        .from('gym_tournament_matches')
                        .update({ next_match_id: inserted[i + 1].id })
                        .eq('id', inserted[i].id);
                    
                    inserted[i].next_match_id = inserted[i + 1].id;
                }
            }
            
            if (inserted) {
                matches.push(...inserted);
            }
        }

        return matches;
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
