(() => {
  let bluetoothPrinterHashKey = null;
  let bluetoothPrinterAddress = null;
  let bluetoothPrinterName = "RPP02N";

  function getPrinterPlugin() {
    const plugins = window.Capacitor && window.Capacitor.Plugins;
    const plugin = plugins && plugins.EscPosPrinter;

    if (!plugin) {
      throw new Error("Plugin EscPosPrinter tidak tersedia. Pastikan aplikasi dijalankan melalui Capacitor Android.");
    }

    return plugin;
  }

  async function cariPrinterBluetooth() {
    try {
      const { devices } = await getPrinterPlugin().getBluetoothPrinterDevices();
      console.log("Bluetooth printers:", devices);
      return devices || [];
    } catch (error) {
      console.error("Gagal mencari printer Bluetooth:", error);
      return [];
    }
  }

  window.cariPrinterBluetooth = cariPrinterBluetooth;
  window.bukaPrinterBluetooth = cariPrinterBluetooth;
  window.PBMSBluetoothPrinter = {
    getPrinterPlugin,
    getState: () => ({ bluetoothPrinterHashKey, bluetoothPrinterAddress, bluetoothPrinterName })
  };
})();
