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
$status = docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $ContainerName 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Bad "Контейнер $ContainerName не создан." "docker compose -f $ComposeFile up -d --wait"
} else {
    $state, $health = $status -split '\|'
    if ($state -ne "running") {
        # Причина отказа при запуске живёт не в журнале, а в состоянии
        # контейнера: без неё "created" выглядит как загадка.
        $startError = docker inspect --format '{{.State.Error}}' $ContainerName 2>$null
        if ($startError -match 'no adapters were found') {
            Write-Bad "Контейнер не стартует: WSL не видит видеокарту." `
                "Так бывает после обновления драйвера NVIDIA без перезагрузки. Перезагрузите Windows, затем: docker compose -f $ComposeFile up -d --wait"
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
}

# --- 3. HTTP ---------------------------------------------------------------

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

# --- 4. Настоящее распознавание -------------------------------------------

Write-Step "Реальное распознавание"
$sample = Join-Path $env:TEMP "whisper_warmup_jfk.wav"
if (-not (Test-Path $sample) -or (Get-Item $sample).Length -eq 0) {
    try {
        Write-Host "        загружаю образец речи..." -ForegroundColor DarkGray
        Invoke-WebRequest -Uri "https://github.com/ggerganov/whisper.cpp/raw/master/samples/jfk.wav" -OutFile $sample -TimeoutSec 30
    } catch {
        Write-Host "        образец скачать не удалось, шаг пропущен" -ForegroundColor Yellow
    }
}

$recognised = $null
if (Test-Path $sample) {
    try {
        $raw = curl.exe -s -X POST "$BaseUrl/v1/audio/transcriptions" `
            -F "file=@$sample" -F "language=en" -F "response_format=json" --max-time 180
        $recognised = ($raw | ConvertFrom-Json).text
    } catch {
        Write-Bad "Запрос на распознавание не прошёл." "Смотрите журнал: docker compose -f $ComposeFile logs --tail 100"
    }

    if ($null -ne $recognised) {
        if ([string]::IsNullOrWhiteSpace($recognised)) {
            Write-Bad "Сервис принял файл, но не распознал НИ ОДНОГО слова." `
                "Это ровно та поломка, при которой /health продолжает врать. Чаще всего — GPU. См. шаг 5."
        } else {
            Write-Ok "распознано: '$($recognised.Trim())'"
        }
    }
}

# --- 5. Журнал -------------------------------------------------------------

Write-Step "Журнал контейнера"
$log = docker logs --tail $LogLines $ContainerName 2>&1 | Out-String

$signatures = @(
    @{ Pattern = 'CUDA failed with error'; Advice = 'GPU недоступен контейнеру. После обновления драйвера NVIDIA перезагрузите Windows, затем: docker compose -f ' + $ComposeFile + ' up -d --force-recreate --wait' },
    @{ Pattern = 'no adapters were found';  Advice = 'WSL не видит видеокарту. Перезагрузите Windows.' },
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
