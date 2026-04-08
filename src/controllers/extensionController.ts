import { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const getExtensionPrices = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('extension_pricing')
      .select('*')
      .order('id', { ascending: true });

    if (error) {
      console.error("Error fetching extension prices:", error);
      return res.status(500).json({ error: 'Failed to fetch extension prices' });
    }

    res.json(data);
  } catch (error) {
    console.error("Internal error in getExtensionPrices:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateExtensionPrice = async (req: Request, res: Response) => {
  try {
    const { id, type, unit_price, unit_quantity } = req.body;

    if (!type || unit_price === undefined || unit_quantity === undefined) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const updateData: any = { 
        type, 
        unit_price, 
        unit_quantity,
        updated_at: new Date().toISOString()
    };

    let result;
    if (id) {
        // Update existing
        const { data, error } = await supabaseAdmin
          .from('extension_pricing')
          .update(updateData)
          .eq('id', id)
          .select()
          .single();
        if (error) throw error;
        result = data;
    } else {
        // Create new (upsert just in case type exists)
        const { data, error } = await supabaseAdmin
          .from('extension_pricing')
          .upsert(updateData, { onConflict: 'type' })
          .select()
          .single();
        if (error) throw error;
        result = data;
    }

    res.json(result);
  } catch (error) {
    console.error("Internal error in updateExtensionPrice:", error);
    res.status(500).json({ error: 'Failed to update extension price' });
  }
};

export const deleteExtensionPrice = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin
      .from('extension_pricing')
      .delete()
      .eq('id', id);

    if (error) {
      console.error("Error deleting extension price:", error);
      return res.status(500).json({ error: 'Failed to delete extension price' });
    }

    res.status(204).send();
  } catch (error) {
    console.error("Internal error in deleteExtensionPrice:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
