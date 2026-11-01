# tablet-tuning

Bancada de PC (adb, sem root) para descobrir **por que** um tablet ou celular Android antigo está
pesado, aplicar um ajuste medido e reverter tudo com um comando.

Não é uma lista de debloat copiada da internet. É um ciclo: **medir → planejar → aplicar → verificar →
reverter**. O perfil de cada aparelho é dado (JSON), não código, e só o que está escrito nele é tocado.

## Requisitos

- [Node.js](https://nodejs.org) 18 ou mais novo (só biblioteca padrão, sem `npm install`)
- `adb` (platform-tools). O script procura no PATH e nos SDKs comuns; `ADB=/caminho/adb` sempre vence
- Depuração USB ligada no aparelho, com a chave do PC autorizada
- Nada de root. Nada é instalado no aparelho.

```bash
adb devices        # precisa listar o aparelho como "device"
```

## Passo a passo

### 1. Medir (só leitura)

```bash
node tools/mode.js measure
```

Grava `out/measure/<aparelho>-<data>.json` com props, tamanho, densidade, lista de pacotes, memória,
CPU e `gfxinfo`. Esse arquivo tem o número de série e a lista dos seus apps: `out/` é ignorado pelo
git de propósito.

### 2. Escolher o perfil

`devices/<marca>/<aparelho>.json`. Já existe o do Redmi Pad SE. Para outro aparelho, veja
[docs/03-metodo.md](docs/03-metodo.md) — a regra é não inventar: pacote sem `why` verificável não entra
em `off`.

### 3. Ver o plano (só leitura)

```bash
node tools/mode.js plan devices/xiaomi/redmi-pad-se.json
```

Mostra o que sairia, o que voltaria, o que já está fora e o que o perfil pede mas a ferramenta recusa.
Nada é alterado.

### 4. Aplicar

```bash
node tools/mode.js apply devices/xiaomi/redmi-pad-se.json --yes
```

Sem `--yes` ele imprime o plano e sai. Com `--yes`, tira os pacotes do usuário 0 e grava o **ledger**
(no aparelho e em `out/ledger/`), que é o que o revert consulta.

### 5. Medir o depois

```bash
node tools/mode.js frames
```

Zera o `gfxinfo`, executa sempre os mesmos 20 gestos e lê o resultado. Comparar janela acumulada
desde o boot não vale: mistura boot, Play Store e uso real.

### 6. Reverter

```bash
node tools/mode.js revert
```

Religa só o que **esta ferramenta** tirou. App que você mesmo desinstalou não volta.

## Resultado no Redmi Pad SE

Android 15 / HyperOS `OS2.0.209.0.VMUMIXM`, 8 GB, `xun`. Detalhes em
[docs/01-diagnostico-redmi-pad-se.md](docs/01-diagnostico-redmi-pad-se.md).

| | antes | depois |
|---|---|---|
| pacotes instalados | 444 | 426 |
| frames travados (20 gestos) | 5/600 (0,83%) | 5/622 (0,80%) |
| p90 / p99 | 10 / 19 ms | 7 / 15 ms |
| load average | 4,56 / 4,50 / 6,10 | 2,64 / 2,87 / 4,36 |
| `com.android.vending:background` | 26 min de CPU em 22 min ligado | 72 s em 30 min |

A lição que justifica o método: o launcher não era o culpado. Uma fila de atualização presa no Play
Store queimava mais de um núcleo desde o boot. Debloat sem medir teria "resolvido" o sintoma errado.

## O que ele não faz

- Não instala nada no aparelho e não precisa de root.
- Não toca em pacote fora do perfil.
- Não desliga o que está em `ALWAYS_KEEP` (tela, ajustes, instalador, permissões, teclado, telefonia,
  GMS), mesmo que o perfil peça.
- Não transforma aparelho lento em rápido: ele remove peso e prova o que mudou.
- Ainda não fala com o aparelho sem PC. A camada no aparelho (Shizuku) está decidida, não implementada.

## Estrutura

```
devices/xiaomi/redmi-pad-se.json   perfil medido (spec 1)
schemas/profile.schema.json        contrato que o perfil precisa cumprir
tools/mode.js                      measure | plan | apply | revert | frames
docs/                              diagnóstico, matriz de capacidade, método
out/                               medições e ledger locais (git ignora)
```

## Por que o revert é confiável

O estado real do aparelho manda, não a saída do comando. São dois ledgers porque são dois mecanismos:

| chave | o que significa | revert usa |
|---|---|---|
| `pc_disabled_owntv` | pacote desligado com `pm disable-user` | `pm enable` |
| `pc_removed_owntv` | pacote tirado do usuário 0 com `pm uninstall -k --user 0` | `pm install-existing` |

O segundo existe porque o HyperOS 15 recusa `disable-user` em pacote de sistema
(`SecurityException: Cannot disable system packages`). O perfil não sabe disso: o `fate` diz *o que*
sai, a ferramenta escolhe *como*. Ver [docs/02-matriz-capacidade.md](docs/02-matriz-capacidade.md).
