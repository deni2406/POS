/**
 * test-lamp.js
 * Standalone test for the Billiard Light Controller module.
 */
const { lampOn } = require('./lamp-controller');

async function runTest() {
    console.log('--- STARTING LAMP CONTROLLER TEST ---');
    console.log('Goal: Open COM3 and send command "11\\r" (Table 1 ON)');
    
    try {
        // Wait briefly to allow the port's 'open' event to fire and log to the console cleanly
        await new Promise(resolve => setTimeout(resolve, 500));

        // Send Table 1 ON (Translates to "11\r" in the controller)
        const result = await lampOn(1);
        
        if (result.success) {
            console.log('\n✅ TEST SUCCESS: Command sent and drained correctly.');
            console.log(`Expected physical result: Table 1 light should turn ON.`);
        } else {
            console.log('\n❌ TEST FAILED: Command was not sent.');
            console.log(`Reason: ${result.message}`);
        }

    } catch (error) {
        console.error('\n❌ UNEXPECTED ERROR during test:', error.message);
    }

    console.log('\nKeeping process alive briefly to allow the controller to respond...');
    
    // Keep process alive for 3 seconds, then exit cleanly
    setTimeout(() => {
        console.log('Exiting test script cleanly.');
        process.exit(0);
    }, 3000);
}

// Execute the test
runTest();