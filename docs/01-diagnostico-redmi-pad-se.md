# O que estava pesado no Redmi Pad SE

Aparelho: Redmi Pad SE (`23073RPBFL`), `ro.product.device` = `xun`, Android 15 (SDK 35),
HyperOS `OS2.0.209.0.VMUMIXM`, 8 GB de RAM, 1200×1920 @ 280 dpi. Medido em 2026-11-01, via USB, sem root.

O dono descreveu o aparelho como "muito pesado". A medição discordou em parte:

| suspeita | realidade medida |
|---|---|
| pouca memória | 7.691 MB de RAM (variante de 8 GB), 4,2 GB disponíveis |
| armazenamento cheio | 223 GB em `/data`, 160 GB livres |
| launcher pesado | 16,96% de frames travados — **consequência**, não causa |
| aparelho antigo/limitado | Snapdragon 680, 8 núcleos, `cached_apps_freezer=disabled` |

O gargalo estava em background. Três achados, em ordem de impacto.

## 1. Play Store preso numa fila de atualização (o culpado)

`com.android.vending:background` queimava **26 minutos de CPU em 22 minutos de aparelho ligado** —
mais de um núcleo inteiro, contínuo, desde o boot. Dois `PARTIAL_WAKE_LOCK` "LONG" em nome do
`PhoneskyJobServiceBackground` impediam o aparelho de dormir. Thread `SessionManager` com 68% do
processo. Load average 6,39 num aparelho de 8 núcleos.

A causa, no log do Finsky:

```
IQ: Requesting install request=... reason=auto_update, account_name=[hash],
    constraints=((REQ_CHARGING, ..., AUTHENTICATION_REQUIRED),)
IU: Account  from AppState for update of com.google.android.apps.docs.editors.docs no longer exists.
IV2: installer unavailable to accept com.exemplo.jogo ... status code 1136
IQ: 13 scheduled install statuses found to proceed.
```

Eram ~13 atualizações automáticas amarradas a uma **conta Google que não existe mais no aparelho**.
A autenticação nunca passa, o instalador nunca aceita, e o Play Store repete o ciclo a cada poucos
milissegundos — segurando wake lock e reagendando jobs (IDs 10550 → 10640 → ...).

`force-stop` não resolve: o `system_server` reergue o job em segundos
(`Start proc ... for service {PhoneskyJobServiceMain} caller=android`). O que resolveu foi jogar a
fila fora, com o dono ciente:

```bash
adb shell pm clear com.android.vending
```

| | antes | depois |
|---|---|---|
| CPU do `:background` | 23 s de CPU em 20 s (~115% de um núcleo) | 1 s em 120 s (~0,8%) |
| wake locks "LONG" do vending | 2 | 0 |
| jobs registrados | 16 | 11 |
| erros de fila (`IQ`/`IV2`) | contínuos | 1 em 120 s |

Efeito colateral esperado: o Play Store pede a conta de novo e a primeira sincronização é pesada
(~30% de um núcleo por alguns minutos) antes de assentar.

## 2. Backup inicial e Google Photos (falso alarme)

Logo depois do boot apareceu um `PARTIAL_WAKE_LOCK` `*backup*` "LONG" há 7 minutos, junto com um job
do Google Photos iniciado na mesma janela. Era a **primeira passada de backup**, não um loop:

```
Backup Manager is enabled / setup complete / not pending init
No backups running
Last backup pass started: 0
next scheduled: +11 h
```

Terminou sozinho. Nada a fazer — e é a prova de que wake lock "LONG" sozinho não é diagnóstico:
precisa do contexto de quem pediu e se ainda está rodando.

## 3. O launcher nunca foi o problema

Baseline acumulado desde o boot: 1.604 frames, 272 travados (16,96%), p99 de 600 ms. Depois de parar
o Play Store, com uma janela limpa e gestos fixos (`node tools/mode.js frames`):

| | antes do debloat | depois do debloat |
|---|---|---|
| frames travados | 5 de 600 (0,83%) | 5 de 622 (0,80%) |
| p50 / p90 | 6 / 10 ms | 6 / 7 ms |
| p95 / p99 | 12 / 19 ms | 9 / 15 ms |
| vsync perdido | 0 | 0 |
| load average | 4,56 / 4,50 / 6,10 | 2,64 / 2,87 / 4,36 |

Ou seja: com o Play Store parado, o launcher já estava em 60 fps. O debloat de 17 pacotes melhorou
memória e background, não frame. Quem prometesse "debloat deixa a home lisinha" estaria vendendo a
causa errada.

## O que foi aplicado

17 pacotes tirados do usuário 0 (ver `devices/xiaomi/redmi-pad-se.json`, todos com `why`):

```
com.miui.msa.global                       com.miui.qr
com.miui.analytics                        com.bsp.logmanager
com.miui.misightservice                   com.longcheertel.AutoTest
com.miui.bugreport                        com.longcheertel.cit
com.mi.globalbrowser                      com.miui.vsimcore
com.miui.videoplayer                      com.miui.fm
com.miui.player                           com.miui.fmservice
com.xiaomi.discover                       com.microsoftsdk.crossdeviceservicebroker
com.miui.thirdappassistant
```

Verificação: 444 → 426 pacotes instalados, nenhum dos 17 em `pm list packages`, `plan` idempotente
(17 "já fora", 0 a fazer), sem `FATAL EXCEPTION` nem `ANR`, home/Settings/Play Store vivos.

Revert: `node tools/mode.js revert`.

## Pontas soltas (medidas, não resolvidas)

- `ueventd` com 2min07s de CPU e 13% num pico. Estranho para um daemon de nós de dispositivo; não
  investigado.
- 4 contas Google no aparelho. O Play Store mantém estado de atualização por conta — é amplificador
  de qualquer trabalho de background. Decisão do dono, não da ferramenta.
- `cached_apps_freezer=disabled` no `xun`. Ligar pode ajudar aparelho com pouca RAM; este tem 8 GB.
