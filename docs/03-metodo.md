# Como medir sem se enganar

A maior parte do "aparelho lento" some quando a medição é feita direito. Estas são as armadilhas que
custaram tempo no Redmi Pad SE.

## 1. Janela acumulada desde o boot não serve

`dumpsys gfxinfo <pkg>` sem `reset` mistura boot, atualização automática e uso real. O baseline de
16,96% de frames travados era quase todo tempestade de boot.

`node tools/mode.js frames` zera as estatísticas, executa **sempre os mesmos 20 gestos** (12 swipes
horizontais + 4 abre/fecha de gaveta) e lê o resultado. Se mudar o gesto, muda o número — e a
comparação morre.

```bash
node tools/mode.js frames                 # com.miui.home
node tools/mode.js frames --pkg com.x     # outro app
```

## 2. CPU de um processo, medida de verdade

`top` de um instante só mostra sorte. O que convence é a variação de tempo de CPU num intervalo fixo:

```bash
adb shell ps -o PID,TIME,NAME -p $(adb shell pidof com.example)   # anote
# espere 20 s
adb shell ps -o PID,TIME,NAME -p $(adb shell pidof com.example)   # anote de novo
```

Delta ≈ 23 s em 20 s de relógio = **mais de um núcleo**. Isso é acusação, não suspeita.

## 3. Antes de culpar o app, olhe quem o acorda

```bash
adb shell logcat -d | grep -E 'Start proc.*<pkg>'      # quem pediu o processo e por quê
adb shell dumpsys jobscheduler | grep -c 'JOB #u0aNNN' # quantos jobs; estabiliza ou cresce?
adb shell dumpsys power | grep -A4 'Wake Locks: size'  # alguém segurando wake lock LONG?
adb shell dumpsys backup | grep -E 'No backups running|Last backup pass'
```

`force-stop` que "não segura" é informação: significa que o `system_server` está reerguendo o
processo para um job ou serviço — o problema não está no processo, está na agenda.

## 4. Log do app, filtrado pelo PID

```bash
adb shell logcat -d -t 2500 | grep ' <pid> ' | tail -40
```

No caso do Play Store, foi o que revelou a fila de instalação presa. Filtrar por PID evita afogar em
log de terceiros.

## Escrever o perfil de um aparelho novo

1. **Medir primeiro** (só leitura):
   ```bash
   node tools/mode.js measure
   ```
2. **Resolver identidade dos pacotes ambíguos.** Nome de pacote mente: `com.bsp.logmanager` é "Log
   generator", `com.xiaomi.ugd` é "GPU Driver Updater". Tire o APK e leia o rótulo:
   ```bash
   adb shell pm path com.example
   adb pull /system/priv-app/Exemplo/Exemplo.apk
   aapt2 dump badging Exemplo.apk | head -2
   ```
3. **Decidir destino** (`fate`) por pacote:
   - `off` — extra de fabricante, promoção, telemetria. **Exige `why` curto e verificável.**
   - `keep` — não tocar (na dúvida, é aqui que se fica).
   - `never` — recusa sempre, mesmo que outra lista mande sair: tela, som, instalação, permissões,
     telefonia, GMS.
   - `off_after_handover` — só depois que existir outra home/screensaver (caso de TV).
4. **Validar contra o schema** antes de aplicar:
   ```bash
   python -c "import jsonschema, json; jsonschema.Draft202012Validator(json.load(open('schemas/profile.schema.json'))).validate(json.load(open('devices/marca/aparelho.json'))); print('ok')"
   ```
5. **Plano seco**, revisar linha por linha, e só então `--yes`.

Regras que não mudam:

- Pacote ausente do aparelho não entra no perfil. Nada por analogia com outra marca.
- `never` é barato; `off` é caro. Na dúvida, `never`.
- `tested` é a data do teste **no aparelho**, não a data em que o arquivo foi escrito.
- Um `why` que você não consegue defender em uma frase é um pacote que volta.
