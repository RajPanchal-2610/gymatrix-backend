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
import { subscriptionScheduler } from './services/subscriptionScheduler';

const app = express();
const port = process.env.PORT || 5000;

app.use(morgan('dev'));
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/staff', staffRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/contact', contactRoutes);

app.get('/', (req, res) => {
  res.send('FitFlow Custom Backend API is running!');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  
  // Initialize the subscription scheduler
  subscriptionScheduler.start();
});
