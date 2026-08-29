$file = "C:\POS\server.js"
$backup = "C:\POS\server.js.backup-before-lamp-watchdog.ps1.js"

Copy-Item $file $backup -Force

$content = Get-Content $file -Raw

if ($content.Contains("LAMP_WATCHDOG_START")) {
    Write-Host "WATCHDOG SUDAH ADA - TIDAK ADA PERUBAHAN" -ForegroundColor Yellow
    exit
}

$marker = "async function recoverLampStateAtStartup() {"

$watchdog = @"
let lampWatchdogRunning = false;

async function reconcileLampState() {
  if (lampWatchdogRunning) return;

  lampWatchdogRunning = true;

  try {
    const rows = await new Promise((resolve, reject) => {
      db.all(
        "SELECT nomor_meja FROM sesi_meja WHERE status = 'AKTIF'",
        [],
        (error, result) => {
          if (error) reject(error);
          else resolve(result || []);
        }
      );
    });

    const activeTables = new Set(
      rows
        .map(row => Number(row.nomor_meja))
        .filter(
          table =>
            Number.isInteger(table) &&
            table >= 1 &&
            table <= 10
        )
    );

    writeLog(
      "INFO",
      "LAMP_WATCHDOG_START",
      "Watchdog lampu melakukan sinkronisasi",
      {
        activeTables: [...activeTables].sort((a, b) => a - b)
      }
    );

    for (let table = 1; table <= 10; table++) {
      try {
        const shouldBeOn = activeTables.has(table);

        const lampRes = shouldBeOn
          ? await lampOn(table)
          : await lampOff(table);

        if (!lampRes || lampRes.success !== true) {
          writeLog(
            "WARN",
            "LAMP_WATCHDOG_FAILED",
            "Watchdog gagal menyinkronkan lampu",
            {
              nomorMeja: table,
              databaseAktif: shouldBeOn,
              lampRes
            }
          );
        }
      } catch (lampError) {
        writeLog(
          "ERROR",
          "LAMP_WATCHDOG_ERROR",
          "Watchdog error saat sinkronisasi lampu",
          {
            nomorMeja: table,
            databaseAktif: activeTables.has(table),
            error: lampError.message
          }
        );
      }
    }

    writeLog(
      "INFO",
      "LAMP_WATCHDOG_COMPLETE",
      "Watchdog lampu selesai"
    );

  } catch (error) {
    writeLog(
      "ERROR",
      "LAMP_WATCHDOG_FATAL",
      "Watchdog gagal membaca status sesi",
      {
        error: error.message
      }
    );
  } finally {
    lampWatchdogRunning = false;
  }
}

"@

if (-not $content.Contains($marker)) {
    Write-Host "MARKER RECOVERY TIDAK DITEMUKAN - TIDAK ADA PERUBAHAN" -ForegroundColor Red
    exit
}

$content = $content.Replace(
    $marker,
    $watchdog + $marker
)

$startup = "    await recoverLampStateAtStartup();"

if (-not $content.Contains($startup)) {
    Write-Host "CALL RECOVERY TIDAK DITEMUKAN - TIDAK ADA PERUBAHAN" -ForegroundColor Red
    Copy-Item $backup $file -Force
    exit
}

$startupNew = @"
    await recoverLampStateAtStartup();

    setInterval(() => {
      reconcileLampState();
    }, 30000);
"@

$content = $content.Replace(
    $startup,
    $startupNew
)

Set-Content $file $content -Encoding UTF8

node --check $file

if ($LASTEXITCODE -eq 0) {
    Write-Host "WATCHDOG BERHASIL DITAMBAHKAN" -ForegroundColor Green
    Write-Host "INTERVAL: 30 DETIK" -ForegroundColor Green
    Write-Host "SYNTAX CHECK LULUS" -ForegroundColor Green
    Write-Host "BACKUP: $backup" -ForegroundColor Yellow
}
else {
    Write-Host "SYNTAX CHECK GAGAL - RESTORE BACKUP" -ForegroundColor Red
    Copy-Item $backup $file -Force
}
