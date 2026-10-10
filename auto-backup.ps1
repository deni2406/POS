$SetDir = Set-Location "C:\POS"
$LogFile = "C:\POS\backup.log"
$TimeStamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

Add-Content -Path $LogFile -Value "[$TimeStamp] Memulai auto-backup..."

try {
    $status = git status --porcelain
    if ($status) {
        git add .
        git commit -m "Auto Backup POS System - $TimeStamp"
        $pushOutput = git push origin HEAD 2>&1
        Add-Content -Path $LogFile -Value "[$TimeStamp] BERHASIL: $pushOutput"
        Write-Host "[BERHASIL] Perubahan berhasil di-commit dan di-push ke GitHub!" -ForegroundColor Green
    } else {
        Add-Content -Path $LogFile -Value "[$TimeStamp] Tidak ada perubahan berkas."
        Write-Host "[OK] Tidak ada perubahan berkas baru." -ForegroundColor Yellow
    }
} catch {
    Add-Content -Path $LogFile -Value "[$TimeStamp] ERROR: $_"
    Write-Host "[ERROR] Backup gagal: $_" -ForegroundColor Red
}
