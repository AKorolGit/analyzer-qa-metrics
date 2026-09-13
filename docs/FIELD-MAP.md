# Мапа полів на IEEE 1044 (крок D5)

| Домен (`RawDefect`) | IEEE 1044 | Azure DevOps | Jira | Хто і коли заповнює |
|---|---|---|---|---|
| `createdAt` | — | `System.CreatedDate` | `created` | автоматично |
| `tDet` (похідне) | Detection date | `System.CreatedDate` або найраніший пов'язаний інцидент | те саме | — |
| `severity` | **Severity** | `Microsoft.VSTS.Common.Severity` | кастомне поле | QA при створенні |
| `priority` | **Priority** | `Microsoft.VSTS.Common.Priority` | `priority` | triage |
| `environmentField` | **Detection activity** | кастомне поле / тег | `environment` | QA при створенні |
| `component` | — | `System.AreaPath` | `components` | QA або авто |
| `versionDetected` | **Version detected** | `Microsoft.VSTS.Build.FoundIn` | `versions` | QA |
| `versionCorrected` | **Version corrected** | `Microsoft.VSTS.Build.IntegrationBuild` | `fixVersions` | dev |
| `rootCause` | **Insertion activity / Cause** | кастомне поле | кастомне поле | dev після фіксу |
| `resolution` | Disposition | `System.Reason` | `resolution` | dev / triage |
| `history` | — | `/workItems/{id}/updates` | `changelog` | автоматично |

## Прогалини, які треба закривати, а не обходити

CTAL-TM 2.3.5 називає чотири обов'язкові атрибути: назва, опис із кроками
відтворення, **severity**, **priority**. Мануал додає три: середовище
виявлення, компонент, версія виявлення. Відсутність будь-якого з семи — це
розрив із вимогою силабуса.

Найчастіший випадок: **Severity не ведеться взагалі**. Тимчасове рішення —
`Imp` v2 (Priority на момент першого triage). Це фіксується в профілі й
друкується в кожному звіті. Постійне рішення — запровадити Severity з
критеріями, бо без нього не працюють ні гейт, ні DDP на критичних дефектах,
ні causal analysis.

Друга пастка ADO: `Priority = 2` — це дефолт. Незмінений P2 означає, що triage
з ним погодився, тому повнота рахується версією v1 (змінено від дефолту за
історією), а не v3 (непорожнє). v3 на полі з дефолтом дає хибні 100%.
