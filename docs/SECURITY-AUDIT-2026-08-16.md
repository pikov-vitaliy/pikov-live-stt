# Аудит зависимостей публикационного кандидата — 2026-08-16

## Вердикт

В границах **аудита базового Python dependency set** исходный код Pikov LiveSTT
готов к публикации с двумя явно зафиксированными VEX-решениями. Этот вывод
относится к исходному репозиторию,
локальному Windows/Docker Desktop-контуру и CI на Ubuntu. Он не является
разрешением на публикацию предварительно собранного Docker/GHCR-образа.

Проверка выполнена `pip-audit 2.10.1` по базовому набору зависимостей из
`uv.lock`. После применения двух VEX-решений результат: `No known
vulnerabilities found, 3 ignored`. Три пропуска — две marker-разновидности
`setuptools` и одна запись `torch`; каждый случай разобран ниже.

## Результаты и VEX

| Идентификатор | Компонент | Решение | Обоснование |
|---|---|---|---|
| `PYSEC-2026-3447`, `CVE-2026-59890`, `GHSA-h35f-9h28-mq5c` | `setuptools 81.0.0` в runtime-графе | `not_affected` для заявленного контура; justification: `vulnerable_code_not_in_execute_path` | Уязвимость находится в обработке правил `MANIFEST.in` при создании `sdist` на macOS APFS/HFS+ и исправлена в `83.0.0`. ASR-сервис не создаёт Python-дистрибутивы, работает в Linux-контейнере, а релизная сборка выполняется на Ubuntu в изолированном PEP 517-окружении. В `[build-system]` задано `setuptools>=83.0.0`. Runtime-версия остаётся ниже 82 из-за ограничения PyTorch 2.11; принудительный override нарушил бы совместимость. |
| `PYSEC-2025-194`, `CVE-2025-3000`, `GHSA-rrmf-rvhw-rf47` | `torch 2.11.0` | `not_affected`; justification: `component_not_affected` | Авторитетная запись PyPA ограничивает затронутые версии значением `last_affected: 2.6.0-NA`. Версия 2.11.0 новее. Срабатывание `pip-audit 2.10.1` вызвано интерпретацией нестандартного суффикса версии в advisory и рассматривается как false positive. |

Источники решений:

- [PyPA advisory для setuptools](https://raw.githubusercontent.com/pypa/advisory-database/main/vulns/setuptools/PYSEC-2026-3447.yaml);
- [исправление setuptools 83.0.0](https://github.com/pypa/setuptools/releases/tag/v83.0.0);
- [PyPA advisory для PyTorch](https://raw.githubusercontent.com/pypa/advisory-database/main/vulns/torch/PYSEC-2025-194.yaml);
- [исходный отчёт PyTorch](https://github.com/pytorch/pytorch/issues/149623).

## Воспроизводимая команда

```powershell
uv export --format requirements-txt --no-dev --no-emit-project --no-hashes `
  --output-file audit-requirements.txt

uvx --python 3.12 --from pip-audit==2.10.1 pip-audit `
  --requirement audit-requirements.txt `
  --no-deps `
  --progress-spinner off `
  --ignore-vuln PYSEC-2025-194 `
  --ignore-vuln PYSEC-2026-3447
```

Исключения допустимы только вместе с этим документом. При изменении версии
PyTorch, платформы сборки, build backend или характера использования
`setuptools` решения нужно пересмотреть.

## Контрольные меры

1. Сборка wheel/sdist использует PEP 517 build isolation и
   `setuptools>=83.0.0` из `pyproject.toml`.
2. Публикационные workflow не запускаются от обычного push/PR; сегодня не
   создаются тег, GitHub Release или GHCR-образ.
3. Docker-сервис публикуется только на `127.0.0.1`, использует
   `faster-whisper`, `LocalAgreement` и модель `large-v3`.
4. Исходный SBOM хранится в `sbom/`; его поля лицензий `NOASSERTION` не
   трактуются как лицензионное разрешение.
5. Перед выпуском Docker-образа обязательны отдельные image-SBOM,
   vulnerability scan, transitive license inventory и provenance модели.

Такой подход поддерживает трассируемое управление рисками и компонентами в
духе ГОСТ Р 56939-2024, NIST SSDF PW.4/PS.3 и практик OWASP Software Component
Verification Standard: finding не удаляется из учёта, а получает проверяемое
решение, ограниченную область применимости и условие повторного анализа.

## Ограничения

- Проверен базовый dependency set; необязательные ASR/диаризационные backend-ы
  требуют отдельного аудита при включении.
- `pip-audit` проверяет известные записи базы, но не доказывает отсутствие
  неизвестных уязвимостей.
- Source-SBOM не охватывает слои CUDA/base image и загружаемые веса модели.
- Пользователь, который запускает уязвимый `setuptools` для создания стороннего
  `sdist` на macOS, выходит за границы данного VEX-решения.
