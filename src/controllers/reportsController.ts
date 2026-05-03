import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

// GET /api/reports/collection
export const getCollectionReport = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const gymId = req.gymId;
        const { startDate, endDate, groupBy = 'month' } = req.query;
        if (!gymId) return res.status(401).json({ error: 'Unauthorized' });

        let query = supabaseAdmin
            .from('gym_payment_transactions')
            .select(`
                amount, 
                paid_at,
                gym_membership_payments (
                    gym_members (
                        full_name
                    ),
                    gym_membership_history (
                        gym_membership_plans (
                            name
                        )
                    )
                )
            `)
            .eq('gym_id', gymId);

        if (startDate) query = query.gte('paid_at', startDate);
        if (endDate) query = query.lte('paid_at', endDate);
        else if (!startDate) {
            query = query.gte('paid_at', new Date(new Date().setFullYear(new Date().getFullYear() - 1)).toISOString());
        }

        console.log(`Fetching collection report for gym: ${gymId}, Period: ${startDate} to ${endDate}`);
        const { data, error } = await query.order('paid_at', { ascending: false });
        if (error) {
            console.error('Database Error in collection report:', error);
            throw error;
        }
        console.log(`Found ${data?.length || 0} transactions for collection report`);

        // Group by month or year for the chart
        const groupedData: { [key: string]: number } = {};
        data?.forEach((tx) => {
            const date = new Date(tx.paid_at);
            let key = '';
            if (groupBy === 'year') {
                key = date.getFullYear().toString();
            } else {
                key = date.toLocaleString('default', { month: 'short', year: '2-digit' });
            }
            groupedData[key] = (groupedData[key] || 0) + Number(tx.amount);
        });

        const summary = Object.keys(groupedData).map(label => ({
            label,
            amount: groupedData[label]
        }));

        res.status(200).json({
            summary,
            details: data // Send each individual record
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

// GET /api/reports/plan-revenue
export const getPlanRevenue = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const gymId = req.gymId;
        const { startDate, endDate, groupBy = 'none' } = req.query;
        if (!gymId) return res.status(401).json({ error: 'Unauthorized' });

        // 1. Fetch all active membership plans for this gym
        const { data: activePlans, error: plansError } = await supabaseAdmin
            .from('gym_membership_plans')
            .select('name')
            .eq('gym_id', gymId)
            .eq('is_deleted', false);

        if (plansError) throw plansError;
        const allPlanNames = activePlans?.map(p => p.name) || [];

        // 2. Fetch transactions for the period - Linked via History for accuracy
        let query = supabaseAdmin
            .from('gym_payment_transactions')
            .select(`
                amount,
                paid_at,
                gym_membership_payments (
                    gym_members (
                        full_name
                    ),
                    gym_membership_history (
                        gym_membership_plans (
                            name
                        )
                    )
                )
            `)
            .eq('gym_id', gymId);

        if (startDate) query = query.gte('paid_at', startDate);
        if (endDate) query = query.lte('paid_at', endDate);

        console.log(`Fetching plan revenue for gym: ${gymId}, Period: ${startDate} to ${endDate}`);
        const { data, error } = await query;
        if (error) {
            console.error('Database Error in plan revenue:', error);
            throw error;
        }
        console.log(`Found ${data?.length || 0} transactions for plan revenue`);

        const planTotals: { [key: string]: number } = {};
        allPlanNames.forEach(name => {
            planTotals[name] = 0;
        });

        data?.forEach((tx: any) => {
            const planName = tx.gym_membership_payments?.gym_membership_history?.gym_membership_plans?.name;
            if (planName) {
                planTotals[planName] = (planTotals[planName] || 0) + Number(tx.amount);
            }
        });

        const summary = Object.keys(planTotals).map(name => ({
            name,
            value: planTotals[name]
        }));

        if (groupBy === 'none') {
            return res.status(200).json({ summary, details: data });
        }

        // Trend View (Monthly/Yearly)
        const trendData: { [key: string]: { [plan: string]: number } } = {};
        data?.forEach((tx: any) => {
            const date = new Date(tx.paid_at);
            const planName = tx.gym_membership_payments?.gym_membership_history?.gym_membership_plans?.name || 'Others';

            let period = '';
            if (groupBy === 'year') {
                period = date.getFullYear().toString();
            } else {
                period = date.toLocaleString('default', { month: 'short', year: '2-digit' });
            }

            if (!trendData[period]) {
                trendData[period] = {};
                allPlanNames.forEach(name => {
                    trendData[period][name] = 0;
                });
            }
            trendData[period][planName] = (trendData[period][planName] || 0) + Number(tx.amount);
        });

        const trendResult = Object.keys(trendData).map(period => ({
            period,
            ...trendData[period]
        }));

        res.status(200).json({ 
            summary, 
            trend: trendResult, 
            plans: allPlanNames, 
            details: data 
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

// GET /api/reports/membership-lifecycle
export const getMembershipLifecycle = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const gymId = req.gymId;
        const { startDate, endDate } = req.query;
        if (!gymId) return res.status(401).json({ error: 'Unauthorized' });

        const sDate = startDate ? new Date(startDate as string) : new Date(new Date().setMonth(new Date().getMonth() - 1));
        const eDate = endDate ? new Date(endDate as string) : new Date();

        // 1. New Admissions - Members who joined in this period
        const { data: newMembers, error: newError } = await supabaseAdmin
            .from('gym_members')
            .select('id, full_name, created_at')
            .eq('gym_id', gymId)
            .gte('created_at', sDate.toISOString())
            .lte('created_at', eDate.toISOString());

        if (newError) throw newError;

        // 2. Renewals & Expiries - From History
        const { data: history, error: historyError } = await supabaseAdmin
            .from('gym_membership_history')
            .select(`
                id, member_id, created_at, end_date,
                gym_members (full_name)
            `)
            .eq('gym_id', gymId);

        if (historyError) throw historyError;

        const stats = {
            new: newMembers?.length || 0,
            renewals: 0,
            expired: 0
        };

        const events: any[] = [];

        // Add New Admissions to events
        newMembers?.forEach(m => {
            events.push({
                member: m.full_name,
                type: 'New Member',
                date: m.created_at
            });
        });

        // Identify renewals (history records that are NOT the first for a member)
        const memberFirstRecords: { [key: number]: string } = {};
        const sortedHistory = (history || []).sort((a, b) =>
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );

        sortedHistory.forEach(record => {
            const createdAt = new Date(record.created_at);
            const endDate = record.end_date ? new Date(record.end_date) : null;
            const memberName = Array.isArray(record.gym_members) 
                ? record.gym_members[0]?.full_name 
                : (record.gym_members as any)?.full_name || 'Unknown Member';

            if (!memberFirstRecords[record.member_id]) {
                memberFirstRecords[record.member_id] = record.created_at;
            } else {
                // This is a renewal
                if (createdAt >= sDate && createdAt <= eDate) {
                    stats.renewals++;
                    events.push({
                        member: memberName,
                        type: 'Renewal',
                        date: record.created_at
                    });
                }
            }

            // Check if this membership expired in the period
            if (endDate && endDate >= sDate && endDate <= eDate) {
                stats.expired++;
                events.push({
                    member: memberName,
                    type: 'Expiry',
                    date: record.end_date
                });
            }
        });

        // Sort events by date descending
        events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        res.status(200).json({
            summary: [
                { name: 'New Members', count: stats.new },
                { name: 'Renewals', count: stats.renewals },
                { name: 'Expiries', count: stats.expired }
            ],
            details: events
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

// GET /api/reports/overview
export const getReportsOverview = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const gymId = req.gymId;
        if (!gymId) return res.status(401).json({ error: 'Unauthorized' });

        const now = new Date();
        const startOfMonthDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const startOfLastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();

        // 1. Total Collection (Life-time)
        const { data: collectionData, error: collError } = await supabaseAdmin
            .from('gym_payment_transactions')
            .select('amount')
            .eq('gym_id', gymId);

        if (collError) throw collError;
        const totalCollection = collectionData?.reduce((acc, curr) => acc + Number(curr.amount), 0) || 0;

        // 1b. This Month vs Last Month Collection
        const { data: thisMonthCollData } = await supabaseAdmin
            .from('gym_payment_transactions')
            .select('amount')
            .eq('gym_id', gymId)
            .gte('paid_at', startOfMonthDate);

        const { data: lastMonthCollData } = await supabaseAdmin
            .from('gym_payment_transactions')
            .select('amount')
            .eq('gym_id', gymId)
            .gte('paid_at', startOfLastMonthDate)
            .lt('paid_at', startOfMonthDate);

        const thisMonthCollection = thisMonthCollData?.reduce((acc, curr) => acc + Number(curr.amount), 0) || 0;
        const lastMonthCollection = lastMonthCollData?.reduce((acc, curr) => acc + Number(curr.amount), 0) || 0;

        let collectionTrend = 0;
        if (lastMonthCollection > 0) {
            collectionTrend = ((thisMonthCollection - lastMonthCollection) / lastMonthCollection) * 100;
        } else if (thisMonthCollection > 0) {
            collectionTrend = 100;
        }

        // 2. Active Members
        const { count: activeCount, error: memberError } = await supabaseAdmin
            .from('gym_members')
            .select('*', { count: 'exact', head: true })
            .eq('gym_id', gymId)
            .eq('status', 'active')
            .eq('is_deleted', false);

        if (memberError) throw memberError;

        // 3. Monthly Growth (New Members)
        const { count: thisMonthNew, error: thisMonthError } = await supabaseAdmin
            .from('gym_members')
            .select('*', { count: 'exact', head: true })
            .eq('gym_id', gymId)
            .gte('created_at', startOfMonthDate)
            .eq('is_deleted', false);

        const { count: lastMonthNew, error: lastMonthError } = await supabaseAdmin
            .from('gym_members')
            .select('*', { count: 'exact', head: true })
            .eq('gym_id', gymId)
            .gte('created_at', startOfLastMonthDate)
            .lt('created_at', startOfMonthDate)
            .eq('is_deleted', false);

        if (thisMonthError || lastMonthError) throw (thisMonthError || lastMonthError);

        // 4. Retention Rate (Active / Total)
        const { count: totalMembers } = await supabaseAdmin
            .from('gym_members')
            .select('*', { count: 'exact', head: true })
            .eq('gym_id', gymId)
            .eq('is_deleted', false);

        let retention = 0;
        if (totalMembers && totalMembers > 0) {
            retention = ((activeCount || 0) / totalMembers) * 100;
        }

        let growth = 0;
        if (lastMonthNew && lastMonthNew > 0) {
            growth = (( (thisMonthNew || 0) - lastMonthNew) / lastMonthNew) * 100;
        } else if (thisMonthNew && thisMonthNew > 0) {
            growth = 100; // 100% growth if we had 0 last month
        }

        res.status(200).json({
            totalCollection,
            thisMonthCollection,
            collectionTrend: collectionTrend.toFixed(1),
            activeMembers: activeCount || 0,
            growth: growth.toFixed(1),
            retention: retention.toFixed(1)
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};
