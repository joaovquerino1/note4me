# Empacotamento e distribuição (macOS)

## Build

```bash
deno task tauri build --bundles app,dmg
```

Saída em `target/release/bundle/macos/note4me.app` e `target/release/bundle/dmg/`. Requisito mínimo declarado: macOS 13 (`bundle.macOS.minimumSystemVersion`). Para um binário universal (Intel + Apple Silicon):

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
```

```bash
deno task tauri build --target universal-apple-darwin
```

## Assinatura e notarização

Sem assinatura, o app roda localmente, mas outros Macs mostram o aviso do Gatekeeper. Para distribuir:

1. Conta Apple Developer e um certificado **Developer ID Application** no Keychain.
2. Defina antes do build:
   - `APPLE_SIGNING_IDENTITY="Developer ID Application: Nome (TEAMID)"`
   - para notarizar: `APPLE_ID`, `APPLE_PASSWORD` (senha específica de app) e `APPLE_TEAM_ID`, ou `APPLE_API_KEY`, `APPLE_API_ISSUER` e `APPLE_API_KEY_PATH`.
3. Rode o build: o Tauri assina com hardened runtime, envia para notarização e grampeia o ticket.

O app não precisa de entitlements extras: não usa rede, câmera ou microfone, e o acesso a arquivos é feito pelas pastas escolhidas pelo usuário. Para distribuir pela Mac App Store seria necessário ativar o App Sandbox e guardar *security-scoped bookmarks* das pastas escolhidas — **ainda não implementado**.

## Ícone

`assets/icon.svg` é a fonte; regenerar com:

```bash
deno task tauri icon assets/icon.svg -o src-tauri/icons
```
