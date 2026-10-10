$SetDir = Set-Location "C:\POS"
$LogFile = "C:\POS\backup.log"
$TimeStamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"

# --- 1. BACKUP DATABASE KE FOLDER LOKAL ---
$BackupFolder = "C:\POS_Backups"

try {
    if (-not (Test-Path $BackupFolder)) {
        New-Item -ItemType Directory -Path $BackupFolder -Force | Out-Null
    }
    
    $DBTarget = Join-Path $BackupFolder "pos_backup_$TimeStamp.db"
    Copy-Item -Path "C:\POS\pos.db" -Destination $DBTarget -Force
    Add-Content -Path $LogFile -Value "[$TimeStamp] BERHASIL: Database disalin ke $DBTarget"
    Write-Host "[BERHASIL] Database disalin ke $BackupFolder" -ForegroundColor Green
} catch {
    Add-Content -Path $LogFile -Value "[$TimeStamp] ERROR Database: $_"
    Write-Host "[ERROR] Gagal backup database: $_" -ForegroundColor Red
}

# --- 2. BACKUP KODE KE GITHUB ---
try {
    $status = git status --porcelain
    if ($status) {
        git add .
        git commit -m "Auto Backup POS System - $TimeStamp"
        $pushOutput = git push origin HEAD 2>&1
        Add-Content -Path $LogFile -Value "[$TimeStamp] BERHASIL Git: $pushOutput"
        Write-Host "[BERHASIL] Kode berhasil di-push ke GitHub!" -ForegroundColor Green
    } else {
        Add-Content -Path $LogFile -Value "[$TimeStamp] Tidak ada perubahan kode."
        Write-Host "[OK] Tidak ada perubahan kode baru." -ForegroundColor Yellow
    }
} catch {
    Add-Content -Path $LogFile -Value "[$TimeStamp] ERROR Git: $_"
    Write-Host "[ERROR] Backup Git gagal: $_" -ForegroundColor Red
}
