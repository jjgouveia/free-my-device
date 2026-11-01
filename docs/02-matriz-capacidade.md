# Matriz de capacidade: o que dá para fazer sem root

Medido no Redmi Pad SE (`xun`, Android 15, HyperOS `OS2.0.209.0.VMUMIXM`), não deduzido da
documentação. "Sem root" = usuário `shell` via ADB por USB. Em outro aparelho, a coluna "dá?" pode
mudar: é a primeira coisa a testar, com uma cobaia só, antes de aplicar qualquer lista.

| Capacidade | Como | Dá? | Observação |
|---|---|---|---|
| Desligar pacote de sistema | `pm disable-user --user 0` | ❌ no HyperOS | `SecurityException: Cannot disable system packages` (`PackageManagerServiceImpl.shouldRestrictEnabledSettingsChange`). Funcionava em Android 11 |
| Tirar pacote de sistema do usuário | `pm uninstall -k --user 0` | ✅ | o APK de sistema continua em `/system`; some da lista de apps instalados |
| Desfazer o de cima | `pm install-existing --user 0` | ✅ | ida e volta testada; é o que o `revert` usa |
| Ler o estado real | `pm list packages` / `-d` | ⚠️ | desinstalado para o usuário **desaparece** de `pm list packages`; `-d` só mostra `disable-user`. Por isso existe o ledger |
| Escalas de animação | `settings put global *_animation_scale` | ✅ | 0.5/0.5/0.5 aplicado e conferido com `settings get` |
| Ler jobs e wake locks | `dumpsys jobscheduler`, `dumpsys power` | ✅ | só leitura — e é onde se acha consumo de background |
| ADB sem fio em `127.0.0.1:5555` | — | ❌ | Android 11+ usa porta aleatória + pareamento TLS; ferramenta que assume 5555 não funciona em celular/tablet |
| Camada de privilégio no aparelho | Shizuku | ⏳ | decidido, não implementado. Roda como `shell`, então **herda exatamente as permissões desta tabela** — não fura bloqueio de ROM |
| Congelar app em segundo plano | `cached_apps_freezer` | ⏳ | no `xun` vem `disabled`; não foi ligado |

## Testar se o seu aparelho bloqueia `disable-user`

Uma cobaia só, reversível, antes de qualquer lote:

```bash
adb shell pm disable-user --user 0 com.miui.msa.global   # se der SecurityException, o caminho é o de baixo
adb shell pm uninstall -k --user 0 com.miui.msa.global
adb shell pm install-existing --user 0 com.miui.msa.global
```

Se o `disable-user` passar, o ledger usa `pc_disabled_owntv` e o revert faz `pm enable`. Se falhar,
o `mode.js` cai sozinho para `uninstall` e grava em `pc_removed_owntv`.

## O que isso muda no desenho

- **O perfil não nomeia mecanismo.** `fate: "off"` diz *o que* sai. *Como* sai é decisão da
  ferramenta, que registra por onde tirou — senão o revert tenta religar do jeito errado.
- **Duas listas, uma verdade.** O ledger local e o `settings global` do aparelho guardam o mesmo
  conjunto; se o PC trocar, o aparelho ainda sabe o que foi feito nele.
- **Shizuku não aumenta poder.** O ganho é não depender de PC, não furar bloqueio. Prometer mais que
  isso seria mentira.
