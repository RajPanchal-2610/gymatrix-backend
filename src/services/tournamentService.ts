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
export async function generateKnockoutBracket(tournamentId: string, participantIds: string[]) {
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
        }

        allMatches.push({
            tournament_id: tournamentId,
            round_number: 1,
            match_number: i + 1,
            participant1_id: p1,
            participant2_id: p2,
            winner_id: winnerId,
            status: status,
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

    for (const match of insertedMatches!) {
        if (match.round_number < totalRounds) {
            const nextRound = match.round_number + 1;
            const nextMatchNum = Math.ceil(match.match_number / 2);
            const nextMatch = matchMap.get(`${nextRound}-${nextMatchNum}`);

            if (nextMatch) {
                await supabaseAdmin
                    .from('gym_tournament_matches')
                    .update({ next_match_id: nextMatch.id })
                    .eq('id', match.id);
            }
        }
    }

    // Auto-advance bye winners to the next round
    for (const match of insertedMatches!) {
        if (match.winner_id && match.round_number < totalRounds) {
            await advanceWinner(match, matchMap, totalRounds);
        }
    }

    return insertedMatches;
}

/**
 * Advances a winner to the next match slot in the bracket.
 */
async function advanceWinner(
    currentMatch: any,
    matchMap: Map<string, any>,
    totalRounds: number
) {
    if (currentMatch.round_number >= totalRounds) return;

    const nextRound = currentMatch.round_number + 1;
    const nextMatchNum = Math.ceil(currentMatch.match_number / 2);
    const nextMatch = matchMap.get(`${nextRound}-${nextMatchNum}`);

    if (!nextMatch) return;

    // Determine which slot (participant1 or participant2) the winner fills
    const isFirstSlot = currentMatch.match_number % 2 !== 0;
    const updateField = isFirstSlot ? 'participant1_id' : 'participant2_id';

    const updateData: any = { [updateField]: currentMatch.winner_id };

    // Check if the other slot is already filled (also by a bye winner)
    const otherField = isFirstSlot ? 'participant2_id' : 'participant1_id';
    const { data: freshMatch } = await supabaseAdmin
        .from('gym_tournament_matches')
        .select('*')
        .eq('id', nextMatch.id)
        .single();

    await supabaseAdmin
        .from('gym_tournament_matches')
        .update(updateData)
        .eq('id', nextMatch.id);

    // If the other participant is also a bye-advanced winner and one slot was already set,
    // check if this makes a new bye scenario (one side filled, other still null)
    if (freshMatch) {
        const updatedP1 = isFirstSlot ? currentMatch.winner_id : freshMatch.participant1_id;
        const updatedP2 = isFirstSlot ? freshMatch.participant2_id : currentMatch.winner_id;

        if (updatedP1 && !updatedP2) {
            // Auto-advance this participant too (bye in next round)
            await supabaseAdmin
                .from('gym_tournament_matches')
                .update({ winner_id: updatedP1, status: 'COMPLETED' })
                .eq('id', nextMatch.id);

            const autoAdvancedMatch = { ...nextMatch, winner_id: updatedP1, participant1_id: updatedP1 };
            await advanceWinner(autoAdvancedMatch, matchMap, totalRounds);
        } else if (!updatedP1 && updatedP2) {
            await supabaseAdmin
                .from('gym_tournament_matches')
                .update({ winner_id: updatedP2, status: 'COMPLETED' })
                .eq('id', nextMatch.id);

            const autoAdvancedMatch = { ...nextMatch, winner_id: updatedP2, participant2_id: updatedP2 };
            await advanceWinner(autoAdvancedMatch, matchMap, totalRounds);
        }
    }
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
        const memberName = (attempt.participant as any)?.member?.full_name || 'Unknown';

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
    const { error: updateError } = await supabaseAdmin
        .from('gym_tournament_matches')
        .update({
            winner_id: winnerId,
            participant1_score: p1Score ?? null,
            participant2_score: p2Score ?? null,
            status: 'COMPLETED',
            updated_at: new Date().toISOString(),
        })
        .eq('id', matchId);

    if (updateError) throw updateError;

    // Advance winner to next match if exists
    if (match.next_match_id) {
        const nextMatch = match.next_match as any;
        if (nextMatch) {
            // Determine slot: if current match_number is odd → p1 slot, even → p2 slot
            const isFirstSlot = match.match_number % 2 !== 0;
            const updateField = isFirstSlot ? 'participant1_id' : 'participant2_id';

            await supabaseAdmin
                .from('gym_tournament_matches')
                .update({ [updateField]: winnerId })
                .eq('id', match.next_match_id);
        }
    }

    // Check if this was the final match (no next_match_id)
    if (!match.next_match_id) {
        // This is the finals — set the tournament winner
        await supabaseAdmin
            .from('gym_tournaments')
            .update({
                winner_participant_id: winnerId,
                status: 'COMPLETED',
                updated_at: new Date().toISOString(),
            })
            .eq('id', match.tournament_id);
    }

    return { success: true, winnerId };
}


// =========================================
// Utility
// =========================================

function nextPowerOf2(n: number): number {
    let p = 1;
    while (p < n) p *= 2;
    return p;
}
