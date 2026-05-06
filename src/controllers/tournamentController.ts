import { Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import * as tournamentService from '../services/tournamentService';

// =========================================
// MASTER DATA ENDPOINTS
// =========================================

/**
 * GET /api/tournaments/master-data
 * Returns all categories with their allowed formats.
 */
export const getMasterData = async (req: Request, res: Response) => {
    try {
        // Fetch categories
        const { data: categories, error: catError } = await supabaseAdmin
            .from('tournament_categories')
            .select('*')
            .order('name');

        if (catError) throw catError;

        // Fetch formats
        const { data: formats, error: fmtError } = await supabaseAdmin
            .from('tournament_formats')
            .select('*')
            .order('name');

        if (fmtError) throw fmtError;

        // Fetch mappings
        const { data: mappings, error: mapError } = await supabaseAdmin
            .from('tournament_category_formats')
            .select('category_id, format_id');

        if (mapError) throw mapError;

        // Build a map of category_id → allowed format_ids
        const categoryFormats: Record<string, string[]> = {};
        for (const m of mappings || []) {
            if (!categoryFormats[m.category_id]) {
                categoryFormats[m.category_id] = [];
            }
            categoryFormats[m.category_id].push(m.format_id);
        }

        res.json({ categories, formats, categoryFormats });
    } catch (error: any) {
        console.error('Get master data error:', error);
        res.status(500).json({ error: 'Failed to fetch tournament master data' });
    }
};

/**
 * POST /api/tournaments/master-data/categories
 * Super Admin: Create a new tournament category.
 */
export const createCategory = async (req: Request, res: Response) => {
    try {
        const { name, description } = req.body;
        if (!name) return res.status(400).json({ error: 'Category name is required' });

        const { data, error } = await supabaseAdmin
            .from('tournament_categories')
            .insert([{ name, description }])
            .select()
            .single();

        if (error) {
            if (error.code === '23505') return res.status(400).json({ error: 'Category already exists' });
            throw error;
        }

        res.status(201).json(data);
    } catch (error: any) {
        console.error('Create category error:', error);
        res.status(500).json({ error: 'Failed to create category' });
    }
};

/**
 * POST /api/tournaments/master-data/formats
 * Super Admin: Create a new tournament format.
 */
export const createFormat = async (req: Request, res: Response) => {
    try {
        const { name, type } = req.body;
        if (!name || !type) return res.status(400).json({ error: 'Name and type are required' });

        const validTypes = ['SCORE_BASED', 'TIME_BASED', 'KNOCKOUT'];
        if (!validTypes.includes(type)) {
            return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
        }

        const { data, error } = await supabaseAdmin
            .from('tournament_formats')
            .insert([{ name, type }])
            .select()
            .single();

        if (error) {
            if (error.code === '23505') return res.status(400).json({ error: 'Format already exists' });
            throw error;
        }

        res.status(201).json(data);
    } catch (error: any) {
        console.error('Create format error:', error);
        res.status(500).json({ error: 'Failed to create format' });
    }
};

/**
 * POST /api/tournaments/master-data/mappings
 * Super Admin: Map a category to a format.
 */
export const createCategoryFormatMapping = async (req: Request, res: Response) => {
    try {
        const { category_id, format_id } = req.body;
        if (!category_id || !format_id) {
            return res.status(400).json({ error: 'category_id and format_id are required' });
        }

        const { data, error } = await supabaseAdmin
            .from('tournament_category_formats')
            .insert([{ category_id, format_id }])
            .select();

        if (error) {
            if (error.code === '23505') return res.status(400).json({ error: 'Mapping already exists' });
            throw error;
        }

        res.status(201).json(data);
    } catch (error: any) {
        console.error('Create mapping error:', error);
        res.status(500).json({ error: 'Failed to create category-format mapping' });
    }
};

// =========================================
// TOURNAMENT CRUD ENDPOINTS
// =========================================

/**
 * POST /api/tournaments
 * Gym Owner: Create a new tournament.
 */
export const createTournament = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const gymId = req.gymId;
        const userId = req.user?.id;

        if (!gymId) return res.status(403).json({ error: 'Gym context not found' });

        const { name, description, start_date, end_date, category_id, format_id, rules } = req.body;

        // Validate required fields
        if (!name || !start_date || !end_date || !category_id || !format_id) {
            return res.status(400).json({ error: 'Missing required fields: name, start_date, end_date, category_id, format_id' });
        }

        // Validate the category-format mapping exists
        const { data: mapping, error: mapError } = await supabaseAdmin
            .from('tournament_category_formats')
            .select('*')
            .eq('category_id', category_id)
            .eq('format_id', format_id)
            .maybeSingle();

        if (mapError) throw mapError;

        if (!mapping) {
            return res.status(400).json({ error: 'Invalid category-format combination. This format is not allowed for the selected category.' });
        }

        const { data, error } = await supabaseAdmin
            .from('gym_tournaments')
            .insert([{
                gym_id: gymId,
                name,
                description,
                start_date,
                end_date,
                category_id,
                format_id,
                rules: rules || {},
                status: 'DRAFT',
                created_by: userId,
            }])
            .select(`
                *,
                category:category_id(id, name),
                format:format_id(id, name, type)
            `)
            .single();

        if (error) throw error;

        res.status(201).json(data);
    } catch (error: any) {
        console.error('Create tournament error:', error);
        res.status(500).json({ error: 'Failed to create tournament' });
    }
};

/**
 * GET /api/tournaments
 * List tournaments for the current gym (or all for super admin).
 */
export const getTournaments = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const gymId = req.gymId;
        const { status } = req.query;

        let query = supabaseAdmin
            .from('gym_tournaments')
            .select(`
                *,
                category:category_id(id, name),
                format:format_id(id, name, type),
                participants:gym_tournament_participants!gym_tournament_participants_tournament_id_fkey(count)
            `)
            .order('created_at', { ascending: false });

        if (gymId) {
            query = query.eq('gym_id', gymId);
        }

        if (status) {
            query = query.eq('status', status as string);
        }

        const { data, error } = await query;
        if (error) throw error;

        // Transform participant count
        const transformed = (data || []).map((t: any) => ({
            ...t,
            participant_count: t.participants?.[0]?.count || 0,
        }));

        res.json(transformed);
    } catch (error: any) {
        console.error('Get tournaments error:', error);
        res.status(500).json({ error: 'Failed to fetch tournaments' });
    }
};

/**
 * GET /api/tournaments/:id
 * Get full tournament details including participants, matches/attempts.
 */
export const getTournamentById = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { id } = req.params;

        // Get tournament with category and format info
        const { data: tournament, error: tError } = await supabaseAdmin
            .from('gym_tournaments')
            .select(`
                *,
                category:category_id(id, name, description),
                format:format_id(id, name, type)
            `)
            .eq('id', id)
            .single();

        if (tError) throw tError;
        if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

        // Get participants with member info
        const { data: participants, error: pError } = await supabaseAdmin
            .from('gym_tournament_participants')
            .select(`
                *,
                member:member_id(id, full_name, phone, email)
            `)
            .eq('tournament_id', id)
            .order('seed_number', { ascending: true });

        if (pError) throw pError;

        const formatType = (tournament.format as any)?.type;
        let matches = null;
        let attempts = null;
        let leaderboard = null;

        if (formatType === 'KNOCKOUT') {
            // Get matches for bracket view
            const { data: matchData, error: matchError } = await supabaseAdmin
                .from('gym_tournament_matches')
                .select(`
                    *,
                    participant1:participant1_id(id, member:member_id(id, full_name)),
                    participant2:participant2_id(id, member:member_id(id, full_name)),
                    winner:winner_id(id, member:member_id(id, full_name))
                `)
                .eq('tournament_id', id)
                .order('round_number', { ascending: true })
                .order('match_number', { ascending: true });

            if (matchError) throw matchError;
            matches = matchData;
        } else {
            // Get attempts for score/time view
            const { data: attemptData, error: attemptError } = await supabaseAdmin
                .from('gym_tournament_attempts')
                .select(`
                    *,
                    participant:participant_id(id, member:member_id(id, full_name))
                `)
                .eq('tournament_id', id)
                .order('participant_id')
                .order('attempt_number', { ascending: true });

            if (attemptError) throw attemptError;
            attempts = attemptData;

            // Calculate leaderboard if there are valid attempts
            try {
                leaderboard = await tournamentService.calculateLeaderboard(id);
            } catch {
                leaderboard = [];
            }
        }

        res.json({
            ...tournament,
            participants,
            matches,
            attempts,
            leaderboard,
        });
    } catch (error: any) {
        console.error('Get tournament error:', error);
        res.status(500).json({ error: 'Failed to fetch tournament details' });
    }
};

/**
 * PATCH /api/tournaments/:id
 * Update tournament (name, description, dates, status, rules).
 */
export const updateTournament = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        // Prevent changing category/format after participants are added
        if (updates.category_id || updates.format_id) {
            const { count } = await supabaseAdmin
                .from('gym_tournament_participants')
                .select('*', { count: 'exact', head: true })
                .eq('tournament_id', id);

            if (count && count > 0) {
                return res.status(400).json({
                    error: 'Cannot change category or format after participants have been added'
                });
            }
        }

        const { data, error } = await supabaseAdmin
            .from('gym_tournaments')
            .update({ ...updates, updated_at: new Date().toISOString() })
            .eq('id', id)
            .select(`
                *,
                category:category_id(id, name),
                format:format_id(id, name, type)
            `)
            .single();

        if (error) throw error;

        res.json(data);
    } catch (error: any) {
        console.error('Update tournament error:', error);
        res.status(500).json({ error: 'Failed to update tournament' });
    }
};

/**
 * DELETE /api/tournaments/:id
 * Delete a tournament (only if DRAFT or CANCELLED).
 */
export const deleteTournament = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { id } = req.params;

        // Check status
        const { data: tournament } = await supabaseAdmin
            .from('gym_tournaments')
            .select('status')
            .eq('id', id)
            .single();

        if (tournament && !['DRAFT', 'CANCELLED'].includes(tournament.status)) {
            return res.status(400).json({ error: 'Can only delete DRAFT or CANCELLED tournaments' });
        }

        const { error } = await supabaseAdmin
            .from('gym_tournaments')
            .delete()
            .eq('id', id);

        if (error) throw error;

        res.json({ success: true, message: 'Tournament deleted successfully' });
    } catch (error: any) {
        console.error('Delete tournament error:', error);
        res.status(500).json({ error: 'Failed to delete tournament' });
    }
};

// =========================================
// PARTICIPANT MANAGEMENT
// =========================================

/**
 * POST /api/tournaments/:id/participants
 * Add participants (bulk). Body: { member_ids: number[] }
 */
export const addParticipants = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { id } = req.params;
        const { member_ids } = req.body;

        if (!member_ids || !Array.isArray(member_ids) || member_ids.length === 0) {
            return res.status(400).json({ error: 'member_ids array is required' });
        }

        // Verify tournament exists and is in DRAFT status
        const { data: tournament, error: tError } = await supabaseAdmin
            .from('gym_tournaments')
            .select('status')
            .eq('id', id)
            .single();

        if (tError || !tournament) return res.status(404).json({ error: 'Tournament not found' });
        if (tournament.status !== 'DRAFT') {
            return res.status(400).json({ error: 'Can only add participants to DRAFT tournaments' });
        }

        // Build participant rows with seed numbers
        const participants = member_ids.map((memberId: number, index: number) => ({
            tournament_id: id,
            member_id: memberId,
            seed_number: index + 1,
        }));

        const { data, error } = await supabaseAdmin
            .from('gym_tournament_participants')
            .upsert(participants, { onConflict: 'tournament_id,member_id' })
            .select(`
                *,
                member:member_id(id, full_name, phone, email)
            `);

        if (error) throw error;

        res.status(201).json(data);
    } catch (error: any) {
        console.error('Add participants error:', error);
        res.status(500).json({ error: 'Failed to add participants' });
    }
};

/**
 * DELETE /api/tournaments/:id/participants/:participantId
 * Remove a participant (only in DRAFT status).
 */
export const removeParticipant = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { id, participantId } = req.params;

        // Verify tournament is in DRAFT status
        const { data: tournament } = await supabaseAdmin
            .from('gym_tournaments')
            .select('status')
            .eq('id', id)
            .single();

        if (tournament && tournament.status !== 'DRAFT') {
            return res.status(400).json({ error: 'Can only remove participants from DRAFT tournaments' });
        }

        const { error } = await supabaseAdmin
            .from('gym_tournament_participants')
            .delete()
            .eq('id', participantId)
            .eq('tournament_id', id);

        if (error) throw error;

        res.json({ success: true, message: 'Participant removed' });
    } catch (error: any) {
        console.error('Remove participant error:', error);
        res.status(500).json({ error: 'Failed to remove participant' });
    }
};

// =========================================
// TOURNAMENT STRUCTURE GENERATION
// =========================================

/**
 * POST /api/tournaments/:id/generate
 * Generate tournament structure (bracket or attempt rows) and set status to ONGOING.
 */
export const generateStructure = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { id } = req.params;

        // Get tournament with format info
        const { data: tournament, error: tError } = await supabaseAdmin
            .from('gym_tournaments')
            .select(`
                *,
                format:format_id(id, name, type)
            `)
            .eq('id', id)
            .single();

        if (tError || !tournament) return res.status(404).json({ error: 'Tournament not found' });
        if (tournament.status !== 'DRAFT') {
            return res.status(400).json({ error: 'Tournament structure can only be generated for DRAFT tournaments' });
        }

        // Get participants
        const { data: participants, error: pError } = await supabaseAdmin
            .from('gym_tournament_participants')
            .select('id')
            .eq('tournament_id', id)
            .order('seed_number', { ascending: true });

        if (pError) throw pError;
        if (!participants || participants.length < 2) {
            return res.status(400).json({ error: 'At least 2 participants are required' });
        }

        const { seedingStrategy, orderedParticipantIds } = req.body;

        let participantIds = participants.map(p => p.id);

        if (seedingStrategy === 'RANDOM') {
            // Fisher-Yates shuffle for random matching
            for (let i = participantIds.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [participantIds[i], participantIds[j]] = [participantIds[j], participantIds[i]];
            }
        } else if (seedingStrategy === 'MANUAL' && Array.isArray(orderedParticipantIds)) {
            // Use the provided manual ordering if it matches the current participants
            if (orderedParticipantIds.length === participantIds.length && orderedParticipantIds.every(id => participantIds.includes(id))) {
                participantIds = orderedParticipantIds;
                
                // Update seed numbers in DB to reflect the new order
                const updates = orderedParticipantIds.map((id, index) => ({
                    id,
                    tournament_id: id, // Actually upsert needs tournament_id to satisfy unique constraints
                    seed_number: index + 1
                }));
                // Just let the backend use the array order for generation
            }
        }

        const formatType = (tournament.format as any)?.type;

        let result;

        if (formatType === 'KNOCKOUT') {
            result = await tournamentService.generateKnockoutBracket(id, participantIds);
        } else {
            // Score-Based or Time-Based
            const attempts = tournament.rules?.attempts || 3; // default 3 attempts
            result = await tournamentService.generateAttempts(id, participantIds, attempts);
        }

        // Update tournament status to ONGOING
        await supabaseAdmin
            .from('gym_tournaments')
            .update({ status: 'ONGOING', updated_at: new Date().toISOString() })
            .eq('id', id);

        res.json({
            message: `Tournament structure generated successfully (${formatType})`,
            structure: result,
        });
    } catch (error: any) {
        console.error('Generate structure error:', error);
        res.status(500).json({ error: error.message || 'Failed to generate tournament structure' });
    }
};

// =========================================
// RESULT ENTRY
// =========================================

/**
 * POST /api/tournaments/:id/matches/:matchId/result
 * Submit knockout match result. Body: { winner_id, participant1_score?, participant2_score? }
 */
export const submitMatchResult = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { matchId } = req.params;
        const { winner_id, participant1_score, participant2_score } = req.body;

        if (!winner_id) return res.status(400).json({ error: 'winner_id is required' });

        const result = await tournamentService.recordMatchResult(
            matchId,
            winner_id,
            participant1_score,
            participant2_score
        );

        res.json(result);
    } catch (error: any) {
        console.error('Submit match result error:', error);
        res.status(500).json({ error: error.message || 'Failed to submit match result' });
    }
};

/**
 * PATCH /api/tournaments/:id/attempts/:attemptId
 * Update an attempt score. Body: { score, status }
 */
export const updateAttempt = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { id, attemptId } = req.params;
        const { score, status } = req.body;

        // Verify tournament is ONGOING
        const { data: tournament } = await supabaseAdmin
            .from('gym_tournaments')
            .select('status')
            .eq('id', id)
            .single();

        if (tournament && tournament.status !== 'ONGOING') {
            return res.status(400).json({ error: 'Can only update attempts for ONGOING tournaments' });
        }

        const updateData: any = { updated_at: new Date().toISOString() };
        if (score !== undefined) updateData.score = score;
        if (status) updateData.status = status;

        const { data, error } = await supabaseAdmin
            .from('gym_tournament_attempts')
            .update(updateData)
            .eq('id', attemptId)
            .eq('tournament_id', id)
            .select(`
                *,
                participant:participant_id(id, member:member_id(id, full_name))
            `)
            .single();

        if (error) throw error;

        res.json(data);
    } catch (error: any) {
        console.error('Update attempt error:', error);
        res.status(500).json({ error: 'Failed to update attempt' });
    }
};

// =========================================
// LEADERBOARD
// =========================================

/**
 * GET /api/tournaments/:id/leaderboard
 * Get the ranked leaderboard for a score-based or time-based tournament.
 */
export const getLeaderboard = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const leaderboard = await tournamentService.calculateLeaderboard(id);
        res.json(leaderboard);
    } catch (error: any) {
        console.error('Get leaderboard error:', error);
        res.status(500).json({ error: error.message || 'Failed to fetch leaderboard' });
    }
};

/**
 * POST /api/tournaments/:id/finalize
 * Finalize a tournament. Sets the winner and status to COMPLETED.
 */
export const finalizeTournament = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { id } = req.params;

        const { data: tournament, error: tError } = await supabaseAdmin
            .from('gym_tournaments')
            .select(`*, format:format_id(type)`)
            .eq('id', id)
            .single();

        if (tError || !tournament) return res.status(404).json({ error: 'Tournament not found' });
        if (tournament.status !== 'ONGOING') {
            return res.status(400).json({ error: 'Can only finalize ONGOING tournaments' });
        }

        const formatType = (tournament.format as any)?.type;
        let winnerId: string | null = null;

        if (formatType === 'KNOCKOUT') {
            // Winner is determined by the final match
            const { data: finalMatch } = await supabaseAdmin
                .from('gym_tournament_matches')
                .select('winner_id')
                .eq('tournament_id', id)
                .is('next_match_id', null)
                .eq('status', 'COMPLETED')
                .single();

            winnerId = finalMatch?.winner_id || null;
        } else {
            // Winner is the top of the leaderboard
            const leaderboard = await tournamentService.calculateLeaderboard(id);
            if (leaderboard.length > 0) {
                winnerId = leaderboard[0].participantId;
            }
        }

        const { data, error } = await supabaseAdmin
            .from('gym_tournaments')
            .update({
                status: 'COMPLETED',
                winner_participant_id: winnerId,
                updated_at: new Date().toISOString(),
            })
            .eq('id', id)
            .select(`
                *,
                category:category_id(id, name),
                format:format_id(id, name, type),
                winner:gym_tournament_participants!fk_tournament_winner(id, member:member_id(id, full_name))
            `)
            .single();

        if (error) throw error;

        res.json({ message: 'Tournament finalized', tournament: data });
    } catch (error: any) {
        console.error('Finalize tournament error:', error);
        res.status(500).json({ error: 'Failed to finalize tournament' });
    }
};
