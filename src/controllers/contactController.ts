import { Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { emailService } from '../services/emailService';

export const submitContactMessage = async (req: Request, res: Response) => {
    try {
        const { full_name, email, subject, message } = req.body;

        if (!full_name || !email || !subject || !message) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        const { data, error } = await supabaseAdmin
            .from('contact_messages')
            .insert([
                { full_name, email, subject, message }
            ])
            .select();

        if (error) {
            console.error('Error saving contact message:', error);
            return res.status(500).json({ error: 'Failed to save message' });
        }

        // Send email notifications asynchronously (don't block the response)
        emailService.sendContactConfirmation(email, full_name, subject);
        emailService.sendContactNotificationToAdmin({ full_name, email, subject, message });

        // Insert system notification in Supabase
        supabaseAdmin
            .from('notifications')
            .insert({
                title: 'New Contact Message',
                message: `Inquiry from ${full_name}: "${subject}"`,
                type: 'system'
            })
            .then(({ error: notifErr }) => {
                if (notifErr) console.error('Error creating contact message notification:', notifErr);
            });

        return res.status(201).json({ 
            message: 'Message sent successfully',
            data: data[0]
        });
    } catch (error) {
        console.error('Unexpected error in submitContactMessage:', error);
        return res.status(500).json({ error: 'An unexpected error occurred' });
    }
};

export const getAllMessages = async (req: Request, res: Response) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('contact_messages')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching contact messages:', error);
            return res.status(500).json({ error: 'Failed to fetch messages' });
        }

        return res.status(200).json(data);
    } catch (error) {
        console.error('Unexpected error in getAllMessages:', error);
        return res.status(500).json({ error: 'An unexpected error occurred' });
    }
};
