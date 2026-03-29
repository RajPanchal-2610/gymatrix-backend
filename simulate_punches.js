const API_URL = 'http://localhost:5000/api/attendance/webhook';
// Replace this with your actual Gym ID from the database
const GYM_ID = 27; 

// Sample device assigned IDs. You must ensure you have a member mapped with device_user_id = '1001' in your database.
const punches = [
    {
        device_user_id: '1001',
        punch_time: new Date().toISOString(), // Check-in time (NOW)
        punch_type: 'IN',
        device_id: 'ZK-FRONT-DOOR'
    },
    {
        device_user_id: '1002',
        punch_time: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // Check-in time (2 hours ago)
        punch_type: 'IN',
        device_id: 'ZK-FRONT-DOOR'
    },
    {
        device_user_id: '1002',
        punch_time: new Date().toISOString(), // Check-out time (NOW)
        punch_type: 'OUT',
        device_id: 'ZK-FRONT-DOOR'
    }
];

async function simulatePunches() {
    console.log(`Starting Punch Simulation for Gym ID: ${GYM_ID}...`);
    
    for (const punch of punches) {
        try {
            const url = `${API_URL}/${GYM_ID}`;
            console.log(`Sending Punch for Device User ${punch.device_user_id} at ${punch.punch_time}`);
            
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(punch)
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                console.error(`❌ Failed for ${punch.device_user_id}:`, data.error || data.message);
            } else {
                console.log(`✅ Success: ${data.message}`);
            }
        } catch (error) {
            console.error(`❌ Request Failed for ${punch.device_user_id}:`, error.message);
        }
        
        // Wait 1 second between punches to simulate real traffic
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log('\nSimulation complete! Check your dashboard Attendance tab to see the records if mapped correctly.');
}

simulatePunches();
