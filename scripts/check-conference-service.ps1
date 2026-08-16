<#
.SYNOPSIS
    Проверяет, что локальный сервис транскрипции действительно распознаёт речь.

.DESCRIPTION
    /health отвечает "ready=true", как только модель загружена в память. Он
    продолжает так отвечать и после того, как распознавание сломалось — именно
    это произошло 16.08.2026, когда обновление драйвера NVIDIA обесценило
    CUDA-контекст уже работавшего контейнера: сервис выглядел здоровым, а любая
    попытка распознать что-либо падала с "CUDA failed with error unknown error".

    Поэтому здесь мало опросить /health. Скрипт прогоняет через сервис реальный
    речевой файл и отдельно ищет в журнале контейнера следы отказов инференса.

.EXAMPLE
    pwsh -File scripts\check-conference-service.ps1
#>

[CmdletBinding()]
param(
    [string]$BaseUrl = "http://127.0.0.1:8001",
    [string]$ComposeFile = "compose.conference.local.yml",
    [string]$ContainerName = "whisperlivekit-conference",
    [int]$LogLines = 400
)

$ErrorActionPreference = "Stop"
$problems = [System.Collections.Generic.List[string]]::new()
$sampleUri = "https://raw.githubusercontent.com/ggerganov/whisper.cpp/1fe009caeda75f69bc864d6370b10674e45a92bd/samples/jfk.wav"
$sampleSha256 = "59DFB9A4ACB36FE2A2AFFC14BACBEE2920FF435CB13CC314A08C13F66BA7860E"

function Write-Step {
    param([string]$Text)
    Write-Host ""
    Write-Host "== $Text" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Text)
    Write-Host "   OK   $Text" -ForegroundColor Green
}

function Write-Bad {
    param([string]$Text, [string]$Advice)
    Write-Host "  FAIL  $Text" -ForegroundColor Red
    if ($Advice) { Write-Host "        -> $Advice" -ForegroundColor Yellow }
    $script:problems.Add($Text)
}

# Длительность образца нужна, чтобы сравнить с ней время распознавания:
# на CPU сервис тоже "работает", просто не успевает за живой речью.
function Get-WavDurationSeconds {
    param([string]$Path)
    try {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        if ($bytes.Length -lt 44) { return $null }
        if ([System.Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne 'RIFF') { return $null }
        $byteRate = [BitConverter]::ToUInt32($bytes, 28)
        if ($byteRate -le 0) { return $null }
        return [math]::Round(($bytes.Length - 44) / $byteRate, 2)
    } catch {
        return $null
    }
}

# --- 1. Docker -------------------------------------------------------------

Write-Step "Docker"
try {
    $serverVersion = docker version --format '{{.Server.Version}}' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $serverVersion) { throw "engine unreachable" }
    Write-Ok "движок отвечает (версия $serverVersion)"
} catch {
    Write-Bad "Docker не отвечает." "Запустите Docker Desktop и дождитесь состояния Running."
    Write-Host ""
    Write-Host "Итог: сервис не работает." -ForegroundColor Red
    exit 1
}

# --- 2. Контейнер ----------------------------------------------------------

Write-Step "Контейнер"
$containerRunning = $false
$status = docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $ContainerName 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Bad "Контейнер $ContainerName не создан." "docker compose -f $ComposeFile up -d --wait"
} else {
    $state, $health = $status -split '\|'
    $containerRunning = ($state -eq "running")
    if ($state -ne "running") {
        # Причина отказа при запуске живёт не в журнале, а в состоянии
        # контейнера: без неё "created" выглядит как загадка.
        $startError = docker inspect --format '{{.State.Error}}' $ContainerName 2>$null
        if ($startError -match 'no adapters were found') {
            Write-Bad "Контейнер не стартует: WSL не видит видеокарту." `
                "Так бывает после обновления драйвера NVIDIA. Выполните wsl --shutdown, дождитесь Docker Desktop, затем: docker compose -f $ComposeFile up -d --wait"
        } elseif ($startError -match 'nvidia|cuda|gpu') {
            Write-Bad "Контейнер не стартует из-за GPU: $startError" `
                "Перезагрузите Windows и повторите запуск."
        } elseif ($startError) {
            Write-Bad "Контейнер в состоянии '$state': $startError" "docker compose -f $ComposeFile up -d --force-recreate --wait"
        } else {
            Write-Bad "Контейнер в состоянии '$state'." "docker compose -f $ComposeFile up -d --force-recreate --wait"
        }
    } elseif ($health -eq "unhealthy") {
        Write-Bad "Контейнер запущен, но healthcheck красный." "docker compose -f $ComposeFile logs --tail 100"
    } else {
        Write-Ok "запущен, healthcheck: $health"
    }

    # Порт обязан оставаться на loopback.
    $ports = docker port $ContainerName 2>$null
    if ($ports -and ($ports -notmatch '127\.0\.0\.1')) {
        Write-Bad "Порт опубликован не только на 127.0.0.1: $ports" "Проверьте секцию ports в $ComposeFile."
    } elseif ($ports) {
        Write-Ok "порт только на loopback: $($ports -join ', ')"
    }

    # Без политики перезапуска сервис не вернётся после перезапуска Docker или
    # WSL. Именно так он молча пролежал 16.08.2026: виртуальная машина WSL
    # перезапустилась, все прочие контейнеры вернулись сами, а этот остался
    # лежать — и обнаружилось это только перед встречей.
    $policy = docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' $ContainerName 2>$null
    if ($policy -in @('unless-stopped', 'always')) {
        Write-Ok "автозапуск включён (restart=$policy)"
    } else {
        Write-Bad "Автозапуск выключен (restart=$policy): после перезапуска Docker или WSL сервис не вернётся." `
            "Убедитесь, что в $ComposeFile есть 'restart: unless-stopped', затем: docker compose -f $ComposeFile up -d --wait"
    }
}

# --- 3. GPU ----------------------------------------------------------------

Write-Step "GPU"
if (-not $containerRunning) {
    Write-Host "        контейнер не запущен — проверка пропущена" -ForegroundColor DarkGray
} else {
    $gpuName = (docker exec $ContainerName nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gpuName)) {
        Write-Bad "Контейнер не видит видеокарту — распознавание уйдёт на CPU." `
            "Бэкенд выбирает устройство сам, поэтому модель всё равно загрузится и /health будет зелёным — сервис просто не будет успевать за речью. Выполните wsl --shutdown, дождитесь Docker Desktop, затем: docker compose -f $ComposeFile up -d --force-recreate --wait"
    } else {
        Write-Ok "видна видеокарта: $gpuName"
    }
}

# --- 4. HTTP ---------------------------------------------------------------

Write-Step "HTTP"
try {
    $health = Invoke-RestMethod "$BaseUrl/health" -TimeoutSec 10
    if ($health.ready) {
        Write-Ok "/health: status=$($health.status), backend=$($health.backend), ready=true"
        Write-Host "        (само по себе это ещё ничего не доказывает — см. следующий шаг)" -ForegroundColor DarkGray
    } else {
        Write-Bad "/health отвечает, но ready=false." "Модель ещё грузится — подождите и повторите."
    }
} catch {
    Write-Bad "$BaseUrl/health недоступен." "Проверьте, что контейнер запущен и порт совпадает."
}

# --- 5. Настоящее распознавание -------------------------------------------

Write-Step "Реальное распознавание"
$sample = Join-Path $env:TEMP "whisper_warmup_jfk.wav"
$sampleIsValid = (Test-Path -LiteralPath $sample) -and
    ((Get-FileHash -LiteralPath $sample -Algorithm SHA256).Hash -eq $sampleSha256)
if (-not $sampleIsValid) {
    try {
        Write-Host "        загружаю образец речи..." -ForegroundColor DarkGray
        Invoke-WebRequest -Uri $sampleUri -OutFile $sample -TimeoutSec 30
        $downloadedHash = (Get-FileHash -LiteralPath $sample -Algorithm SHA256).Hash
        if ($downloadedHash -ne $sampleSha256) {
            Remove-Item -LiteralPath $sample -Force
            throw "SHA-256 mismatch: expected $sampleSha256, received $downloadedHash"
        }
    } catch {
        Write-Bad "Проверенный образец речи недоступен — распознавание НЕ проверено." `
            "Проверьте сеть и повторите запуск. Скрипт принимает только закреплённый файл с ожидаемым SHA-256."
    }
}

function Invoke-Transcription {
    curl.exe -s -X POST "$BaseUrl/v1/audio/transcriptions" `
        -F "file=@$sample" -F "language=en" -F "response_format=json" --max-time 180
}

$recognised = $null
if (Test-Path $sample) {
    try {
        $recognised = (Invoke-Transcription | ConvertFrom-Json).text
    } catch {
        Write-Bad "Запрос на распознавание не прошёл." "Смотрите журнал: docker compose -f $ComposeFile logs --tail 100"
    }

    if ($null -ne $recognised) {
        if ([string]::IsNullOrWhiteSpace($recognised)) {
            Write-Bad "Сервис принял файл, но не распознал НИ ОДНОГО слова." `
                "Это ровно та поломка, при которой /health продолжает врать. Чаще всего — GPU. См. шаги 3 и 6."
        } else {
            Write-Ok "распознано: '$($recognised.Trim())'"

            # Скорость меряем ВТОРЫМ запросом: на первом после старта контейнера
            # ещё компилируются CUDA-ядра, и он не отражает рабочий темп.
            $duration = Get-WavDurationSeconds $sample
            if ($null -eq $duration) {
                Write-Host "        длительность образца не определена — скорость не проверена" -ForegroundColor DarkGray
            } else {
                $sw = [System.Diagnostics.Stopwatch]::StartNew()
                $null = Invoke-Transcription
                $sw.Stop()
                $elapsed = [math]::Round($sw.Elapsed.TotalSeconds, 1)
                if ($elapsed -ge $duration) {
                    Write-Bad "Распознавание медленнее реального времени: ${elapsed} с на ${duration} с речи." `
                        "На живой встрече отставание будет только расти. Обычная причина — модель ушла на CPU: устройство выбирается автоматически, и без видимого GPU сервис молча продолжает работать вдвое-впятеро медленнее. См. шаг 3."
                } else {
                    $margin = [math]::Round($duration / [math]::Max($elapsed, 0.1), 1)
                    Write-Ok "скорость: ${elapsed} с на ${duration} с речи (запас x$margin)"
                }
            }
        }
    }
}

# --- 6. Журнал -------------------------------------------------------------

Write-Step "Журнал контейнера"
$log = docker logs --tail $LogLines $ContainerName 2>&1 | Out-String

$signatures = @(
    @{ Pattern = 'CUDA failed with error'; Advice = 'GPU недоступен контейнеру. После обновления драйвера NVIDIA выполните wsl --shutdown — проверено, этого достаточно, перезапуск одного дистрибутива не помогает. Дождитесь Docker Desktop, затем: docker compose -f ' + $ComposeFile + ' up -d --force-recreate --wait' },
    @{ Pattern = 'no adapters were found';  Advice = 'WSL не видит видеокарту. Выполните wsl --shutdown и запустите Docker Desktop заново; перезагрузка Windows нужна, только если это не помогло.' },
    @{ Pattern = 'out of memory';           Advice = 'Не хватает видеопамяти. Возьмите модель полегче: WLK_MODEL=large-v3-turbo в .env, затем пересоздайте контейнер.' },
    @{ Pattern = 'Exception in transcription_processor'; Advice = 'Распознавание падает. Полный текст: docker compose -f ' + $ComposeFile + ' logs --tail 200' }
)

$found = $false
foreach ($s in $signatures) {
    if ($log -match $s.Pattern) {
        Write-Bad "в журнале найдено: '$($s.Pattern)'" $s.Advice
        $found = $true
    }
}
if (-not $found) { Write-Ok "следов отказов распознавания не найдено" }

# --- Итог ------------------------------------------------------------------

Write-Host ""
if ($problems.Count -eq 0) {
    Write-Host "Итог: сервис действительно распознаёт речь. Можно начинать встречу." -ForegroundColor Green
    exit 0
}

Write-Host "Итог: найдено проблем — $($problems.Count). Начинать встречу нельзя." -ForegroundColor Red
foreach ($p in $problems) { Write-Host "  - $p" -ForegroundColor Red }
exit 1
