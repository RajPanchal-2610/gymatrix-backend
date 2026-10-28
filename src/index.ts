import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';

// Load environment variables IMMEDIATELY
dotenv.config();

import staffRoutes from './routes/staffRoutes';
import rolesRoutes from './routes/rolesRoutes';
import attendanceRoutes from './routes/attendanceRoutes';
import paymentRoutes from './routes/paymentRoutes';
import notificationRoutes from './routes/notificationRoutes';
import contactRoutes from './routes/contactRoutes';
import couponsRoutes from './routes/couponsRoutes';
import reportsRoutes from './routes/reportsRoutes';
import tournamentRoutes from './routes/tournamentRoutes';
import globalTournamentRoutes from './routes/globalTournamentRoutes';
import workoutRoutes from './routes/workoutRoutes';
import gymRoutes from './routes/gymRoutes';
import publicRoutes from './routes/publicRoutes';
import leadRoutes from './routes/leadRoutes';
import whatsappRoutes from './routes/whatsappRoutes';
import memberRoutes from './routes/memberRoutes';
import { subscriptionScheduler } from './services/subscriptionScheduler';

const app = express();
const port = process.env.PORT || 5000;

app.use(morgan('dev'));
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', leadRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/members', memberRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/coupons', couponsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/tournaments/global', globalTournamentRoutes);
app.use('/api/tournaments', tournamentRoutes);
app.use('/api/workouts', workoutRoutes);
app.use('/api/gyms', gymRoutes);
app.use('/api/public', publicRoutes);

app.get('/', (req, res) => {
  res.send('Gymatrix Custom Backend API is running!');
});

import { supabaseAdmin } from './lib/supabase';

async function initializeStorageBuckets() {
  try {
    const { data: buckets, error } = await supabaseAdmin.storage.listBuckets();
    if (error) throw error;

    const exists = buckets.some(b => b.id === 'tournament-videos');
    if (!exists) {
      const { error: createError } = await supabaseAdmin.storage.createBucket('tournament-videos', {
        public: true,
        allowedMimeTypes: ['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm']
      });
      if (createError) throw createError;
      console.log('✅ Created Supabase storage bucket: tournament-videos');
    } else {
      console.log('✅ Supabase storage bucket already exists: tournament-videos');
    }
  } catch (err) {
    console.error('❌ Failed to initialize Supabase storage buckets:', err);
  }
}

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  initializeStorageBuckets();

  // Initialize the subscription scheduler
  subscriptionScheduler.start();
});
