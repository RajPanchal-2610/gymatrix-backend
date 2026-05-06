import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
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
router.get('/', authenticate, tournamentController.getTournaments);
router.post('/', authenticate, tournamentController.createTournament);
router.get('/:id', authenticate, tournamentController.getTournamentById);
router.patch('/:id', authenticate, tournamentController.updateTournament);
router.delete('/:id', authenticate, tournamentController.deleteTournament);

// =========================================
// Participants
// =========================================
router.post('/:id/participants', authenticate, tournamentController.addParticipants);
router.delete('/:id/participants/:participantId', authenticate, tournamentController.removeParticipant);

// =========================================
// Structure Generation & Results
// =========================================
router.post('/:id/generate', authenticate, tournamentController.generateStructure);
router.post('/:id/matches/:matchId/result', authenticate, tournamentController.submitMatchResult);
router.patch('/:id/attempts/:attemptId', authenticate, tournamentController.updateAttempt);

// =========================================
// Leaderboard & Finalization
// =========================================
router.get('/:id/leaderboard', authenticate, tournamentController.getLeaderboard);
router.post('/:id/finalize', authenticate, tournamentController.finalizeTournament);

export default router;
