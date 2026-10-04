/**
 * lamp-controller.js
 * Handles shared serial communication with the Billiard Light Controller on COM3.
 */
const { SerialPort } = require('serialport');

// ==================================================
// SERIAL CONFIGURATION
// ==================================================
const SERIAL_PATH = 'COM3';
const BAUD_RATE = 9600;
const DATA_BITS = 8;
const STOP_BITS = 1;
const PARITY = 'none';
const LINE_TERMINATOR = '\r\n';

// Shared serial connection
let port = null;

// Promise used while COM3 is opening
let openingPromise = null;

// Serialize all lamp commands so COM3 is never written concurrently
let commandQueue = Promise.resolve();

// ==================================================
// INITIALIZE SERIAL PORT
// ==================================================
function initSerialPort() {
    if (port) {
        return port;
    }

    try {
        port = new SerialPort({
            path: SERIAL_PATH,
            baudRate: BAUD_RATE,
            dataBits: DATA_BITS,
            stopBits: STOP_BITS,
            parity: PARITY,
            xon: false,
            xoff: false,
            autoOpen: false
        });

        port.on('open', () => {
            console.log(
                `[LAMP CONTROLLER] ${SERIAL_PATH} Opened Successfully at ${BAUD_RATE} baud.`
            );
        });

        port.on('data', () => {});

        port.on('error', (err) => {
            console.error(
                `[LAMP CONTROLLER] Serial Error on ${SERIAL_PATH}:`,
                err.message
            );
        });

        port.on('close', () => {
            console.warn(
                `[LAMP CONTROLLER] ${SERIAL_PATH} Closed. Will attempt to reopen on next command.`
            );

            if (port) {
                port = null;
            }

            openingPromise = null;
        });

    } catch (error) {
        console.error(
            `[LAMP CONTROLLER] Failed to initialize ${SERIAL_PATH}:`,
            error.message
        );

        port = null;
    }

    return port;
}

// ==================================================
// ENSURE COM3 IS REALLY OPEN
// ==================================================
function ensureSerialPortOpen() {
    if (port && port.isOpen) {
        return Promise.resolve(port);
    }

    if (openingPromise) {
        return openingPromise;
    }

    if (!port) {
        initSerialPort();
    }

    if (!port) {
        return Promise.reject(
            new Error(`Serial port ${SERIAL_PATH} unavailable`)
        );
    }

    openingPromise = new Promise((resolve, reject) => {
        const currentPort = port;

        const cleanup = () => {
            currentPort.removeListener('open', onOpen);
            currentPort.removeListener('error', onError);
            currentPort.removeListener('close', onCloseBeforeOpen);
        };

        const onOpen = () => {
            cleanup();
            openingPromise = null;
            resolve(currentPort);
        };

        const onError = (err) => {
            cleanup();
            openingPromise = null;
            reject(err);
        };

        const onCloseBeforeOpen = () => {
            cleanup();
            openingPromise = null;
            reject(
                new Error(`Serial port ${SERIAL_PATH} closed before opening`)
            );
        };

        currentPort.once('open', onOpen);
        currentPort.once('error', onError);
        currentPort.once('close', onCloseBeforeOpen);

        try {
            currentPort.open((err) => {
                if (err) {
                    onError(err);
                }
            });
        } catch (error) {
            onError(error);
        }
    });

    return openingPromise;
}

// ==================================================
// LOW-LEVEL SEND COMMAND
// ==================================================
async function sendLampCommand(table, stat) {
    const rawCommand = `${table}${stat}`;
    const command = rawCommand + LINE_TERMINATOR;

    try {
        const serialPort = await ensureSerialPortOpen();

        console.log(
            `[LAMP CONTROLLER] Sending command: ${rawCommand} ` +
            `(Table ${table} ${stat === 1 ? 'ON' : 'OFF'})`
        );

        await new Promise((resolve, reject) => {
            let settled = false;

            const finish = (err) => {
                if (settled) return;

                settled = true;

                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            };

            serialPort.write(command, (err) => {
                if (err) {
                    finish(err);
                    return;
                }

                // Tunggu buffer serial benar-benar drained sebelum command berikutnya
                // dijalankan oleh commandQueue. Ini mencegah command antar meja
                // bertumpuk terlalu cepat di controller COM3.
                try {
                    serialPort.drain((drainErr) => {
                        if (drainErr) {
                            console.warn(
                                `[LAMP CONTROLLER] Serial drain warning ${rawCommand}:`,
                                drainErr.message
                            );

                            finish(drainErr);
                            return;
                        }

                        finish();
                    });
                } catch (drainError) {
                    console.warn(
                        `[LAMP CONTROLLER] Serial drain warning ${rawCommand}:`,
                        drainError.message
                    );

                    finish(drainError);
                }
            });
        });

        return {
            success: true,
            command: rawCommand
        };

    } catch (error) {
        console.error(
            `[LAMP CONTROLLER] Error sending command ${rawCommand} to ${SERIAL_PATH}:`,
            error.message
        );

        return {
            success: false,
            command: rawCommand,
            message: error.message || 'Failed to write to port'
        };
    }
}

// ==================================================
// LAMP SET
// ==================================================
function lampSet(tableNumber, status) {
    const table = parseInt(tableNumber, 10);
    const stat = parseInt(status, 10);

    // Validate inputs
    if (isNaN(table) || table < 1 || table > 10) {
        console.error(
            '[LAMP CONTROLLER] Invalid table number:',
            tableNumber
        );

        return Promise.resolve({
            success: false,
            message: 'Invalid table number'
        });
    }

    if (stat !== 0 && stat !== 1) {
        console.error(
            '[LAMP CONTROLLER] Invalid status:',
            status
        );

        return Promise.resolve({
            success: false,
            message: 'Invalid status'
        });
    }

    // Queue every command so COM3 is never written concurrently
    const task = commandQueue.then(
        () => sendLampCommand(table, stat),
        () => sendLampCommand(table, stat)
    );

    commandQueue = task.catch(() => {});

    return task;
}

// ==================================================
// SIMPLE ON / OFF
// ==================================================
function lampOn(tableNumber) {
    return lampSet(tableNumber, 1);
}

function lampOff(tableNumber) {
    return lampSet(tableNumber, 0);
}

// ==================================================
// 15 MINUTE WARNING BLINK
// ON -> OFF -> ON -> OFF -> ON
// ==================================================
async function lampBlink15Minute(tableNumber, intervalMs = 500) {
    const table = parseInt(tableNumber, 10);

    if (isNaN(table) || table < 1 || table > 10) {
        return {
            success: false,
            message: 'Invalid table number'
        };
    }

    const delay =
        Number.isFinite(Number(intervalMs)) &&
        Number(intervalMs) > 0
            ? Number(intervalMs)
            : 500;

    const wait = (ms) =>
        new Promise(resolve => setTimeout(resolve, ms));

    const firstOn = await lampOn(table);
    if (!firstOn || firstOn.success !== true) {
        return firstOn || {
            success: false,
            message: 'Lamp ON failed'
        };
    }

    await wait(delay);

    const firstOff = await lampOff(table);
    if (!firstOff || firstOff.success !== true) {
        return firstOff || {
            success: false,
            message: 'Lamp OFF failed'
        };
    }

    await wait(delay);

    const secondOn = await lampOn(table);
    if (!secondOn || secondOn.success !== true) {
        return secondOn || {
            success: false,
            message: 'Lamp ON failed'
        };
    }

    await wait(delay);

    const secondOff = await lampOff(table);
    if (!secondOff || secondOff.success !== true) {
        return secondOff || {
            success: false,
            message: 'Lamp OFF failed'
        };
    }

    await wait(delay);

    const restoreOn = await lampOn(table);
    if (!restoreOn || restoreOn.success !== true) {
        return restoreOn || {
            success: false,
            message: 'Lamp restore ON failed'
        };
    }

    return {
        success: true,
        table
    };
}

// ==================================================
// INITIALIZE OBJECT ONLY
// COM3 WILL BE OPENED WHEN FIRST COMMAND IS SENT
// ==================================================
initSerialPort();

// ==================================================
// EXPORTS
// ==================================================
module.exports = {
    lampSet,
    lampOn,
    lampOff,
    lampBlink15Minute
};
