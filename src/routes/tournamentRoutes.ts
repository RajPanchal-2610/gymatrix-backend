import { Router } from 'express';
import { authenticate, requireFeature, requirePermission } from '../middleware/authMiddleware';
import * as tournamentController from '../controllers/tournamentController';

const router = Router();

// =========================================
// Master Data (Public read, Super Admin write)
// =========================================
router.get('/master-data', tournamentController.getMasterData);
router.post('/master-data/categories', tournamentController.createCategory);
router.post('/master-data/formats', tournamentController.createFormat);
router.post('/master-data/mappings', tournamentController.createCategoryFormatMapping);

// =========================================
// Tournament CRUD (Gym Owner - Authenticated)
// =========================================
router.get('/', ...requireFeature('tournament'), ...requirePermission('view_tournaments'), tournamentController.getTournaments);
router.post('/', ...requireFeature('tournament'), ...requirePermission('add_tournaments'), tournamentController.createTournament);
router.get('/:id', ...requireFeature('tournament'), ...requirePermission('view_tournaments'), tournamentController.getTournamentById);
router.patch('/:id', ...requireFeature('tournament'), ...requirePermission('edit_tournaments'), tournamentController.updateTournament);
router.delete('/:id', ...requireFeature('tournament'), ...requirePermission('delete_tournaments'), tournamentController.deleteTournament);

// =========================================
// Participants
// =========================================
router.post('/:id/participants', ...requireFeature('tournament'), ...requirePermission('edit_tournaments'), tournamentController.addParticipants);
router.delete('/:id/participants/:participantId', ...requireFeature('tournament'), ...requirePermission('edit_tournaments'), tournamentController.removeParticipant);

// =========================================
// Structure Generation & Results
// =========================================
router.post('/:id/generate', ...requireFeature('tournament'), ...requirePermission('edit_tournaments'), tournamentController.generateStructure);
router.post('/:id/advance', ...requireFeature('tournament'), ...requirePermission('edit_tournaments'), tournamentController.advanceTournamentPhase);
router.post('/:id/resolve-tie', ...requireFeature('tournament'), ...requirePermission('edit_tournaments'), tournamentController.resolveTieBreaker);
router.post('/:id/matches/:matchId/result', ...requireFeature('tournament'), ...requirePermission('edit_tournaments'), tournamentController.submitMatchResult);
router.patch('/:id/attempts/:attemptId', ...requireFeature('tournament'), ...requirePermission('edit_tournaments'), tournamentController.updateAttempt);

// =========================================
// Leaderboard & Finalization
// =========================================
router.get('/:id/leaderboard', ...requireFeature('tournament'), ...requirePermission('view_tournaments'), tournamentController.getLeaderboard);
router.post('/:id/finalize', ...requireFeature('tournament'), ...requirePermission('edit_tournaments'), tournamentController.finalizeTournament);

export default router;

