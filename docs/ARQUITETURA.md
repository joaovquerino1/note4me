# Arquitetura e decisões técnicas

## Visão geral

```
┌──────────────────────────── WKWebView (UI) ────────────────────────────┐
│ React + TypeScript: barra lateral, editor TipTap, coleções, ajustes     │
│ editor/markdown: Markdown ⇄ documento do editor (preservação de origem) │
└───────────────▲──────────────────────────────────────┬──────────────────┘
                │ eventos (menu, vault:changed)        │ invoke (IPC tipado)
┌───────────────┴──────────── src-tauri (Rust) ────────▼──────────────────┐
│ commands.rs  validação de entrada → chamadas ao núcleo → erros tipados   │
│ watcher.rs   FSEvents (notify) → atualização incremental do índice       │
│ menu.rs      barra de menus nativa · fonts.rs  CoreText (fontes reais)   │
└───────────────────────────────▲──────────────────────────────────────────┘
┌───────────────────────────────┴──── note4me-core (Rust puro) ───────────┐
│ paths · fsio · markdown/{frontmatter,links,text} · workspace · index     │
│ history · trash · drafts · attachments · collections · import_export     │
│ settings · themes · state                                                │
└─────────────────────────────────────────────────────────────────────────┘
                 Arquivos .md no disco = fonte da verdade
```

## Escolha da stack

| Opção | Prós | Contras | Decisão |
|---|---|---|---|
| **Tauri 2 + React + TipTap** | núcleo em Rust; editor de blocos maduro (ProseMirror); acessibilidade do WebKit; app pequeno (15 MB) | interface é HTML numa WebView, não AppKit | **escolhida** |
| egui / iced | 100% Rust | edição de rich text e VoiceOver imaturos; construir um editor de blocos do zero | descartada |
| AppKit via objc2 | controles nativos reais | escrever um editor de blocos completo em AppKit; custo muito alto | descartada |
| Electron | ecossistema | runtime pesado; Rust apenas como addon | descartada |

**Transparência:** menus, diálogos de arquivo, janela, semáforos e arrastar do Finder são nativos. Todo o resto (barra lateral, editor, ajustes) é HTML/CSS renderizado pelo WebKit do sistema, estilizado para se integrar ao macOS — não são controles AppKit.

Frontend sem Node: o projeto usa **Deno 2** como runtime npm (já disponível no ambiente). O `package.json` é padrão; `npm install && npm run tauri dev` também funciona.

## Princípio: regras de negócio em Rust

O TypeScript faz apresentação e interação. Tudo o que toca arquivos ou decide sobre integridade está no núcleo, testado com `cargo test` sem UI: validação de caminhos, nomes, escrita atômica, conflitos, frontmatter, links, busca, coleções (filtro/ordenação/agrupamento), temas (validação/contraste), limites das preferências.

A única lógica de conteúdo no TypeScript é a conversão Markdown ⇄ documento do editor, porque o modelo do documento vive no editor. Ela é coberta por testes de round-trip (`src/editor/markdown/roundtrip.test.ts`).

## Armazenamento

- **Escrita atômica** (`fsio::atomic_write`): arquivo temporário na mesma pasta → `write` → `fsync` → `rename` → `fsync` da pasta. Permissões do arquivo original são mantidas.
- **Criação sem sobrescrita** (`write_new`, `copy_new`): `O_CREAT|O_EXCL`; nomes únicos comparados sem diferenciar maiúsculas (APFS).
- **Codificação:** UTF-8 estrito; BOM e CRLF lembrados e restaurados.
- **Conflitos:** cada página aberta guarda o hash (BLAKE3) do arquivo que carregou. `save_page` relê o disco; se o hash mudou, nada é gravado e o conflito volta à UI com o conteúdo do disco. Forçar a gravação primeiro guarda a versão do disco no histórico. Um arquivo removido enquanto editado também é conflito.
- **Frontmatter** é sempre mantido como está no disco ao salvar o corpo; propriedades mudam só por `set_property` (edição cirúrgica + verificação).
- **Rascunhos:** salvamentos que falham ou entram em conflito deixam o texto em `.note4me/drafts/`; ao reabrir a página, a UI oferece restaurar.
- **Renomear/mover:** valida todos os destinos antes, move no disco desfazendo os movimentos anteriores se um falhar, reescreve links, atualiza índice, favoritos, ordem e histórico.
- **Lixeira** dentro do vault (`.note4me/trash`) para permitir restaurar no próprio app; a lixeira do macOS não é usada.

## Índice e busca

- Em memória, construído varrendo o vault (ignora ocultos e links simbólicos). Não é persistido — portanto nunca diverge do disco entre execuções; SQLite foi considerado e descartado por não trazer ganho mensurável neste porte.
- Atualização incremental por caminho a partir dos eventos do FSEvents (debounce 250 ms); gravações do próprio app atualizam o índice diretamente.
- Cada arquivo é indexado isoladamente; erros viram status (`tooLarge`, `invalidEncoding`, `invalidFrontmatter`) sem afetar os demais.
- Busca: termos AND, frases, `tag:`, `path:`; normalização de maiúsculas e acentos com mapeamento 1:1 de caracteres (os trechos mostram o texto original); pontuação por título, tags, propriedades, títulos de seção e frequência.

## Editor e fidelidade Markdown

`markdown-it` (CommonMark + tabelas + tachado + regras próprias para tarefas, wiki links, notas de rodapé, matemática, embeds) → `prosemirror-markdown` → documento TipTap. Cada bloco de primeiro nível recebe atributos não renderizados: `mdsrc` (linhas originais), `mdgap` (texto até o próximo bloco, incluindo definições de links de referência) e `mdfp` (impressão digital do bloco analisado). Na serialização, bloco com a mesma impressão digital é emitido de `mdsrc`; os demais são serializados e separados por linha em branco para não se fundirem com os vizinhos.

## Watcher e reconciliação

`vault:changed` chega à UI com os caminhos afetados. A página aberta relê o arquivo: hash igual → ignora (era a própria gravação); sem edições pendentes → recarrega e avisa; com edições pendentes → banner de conflito.

## Segurança

- Toda entrada de caminho é um `RelPath` (sem `..`, `\`, NUL, componentes vazios); `ensure_within` resolve symlinks e recusa destinos fora do vault; `.note4me/` não é acessível pelos comandos de página.
- CSP restritiva (sem scripts externos, `object-src 'none'`, `connect-src` só IPC). O protocolo de assets só libera a pasta do vault aberto.
- `open_external` só abre `http`, `https` e `mailto`. Conteúdo importado nunca é executado.
- Nomes de fonte são filtrados antes de entrar no CSS; temas importados são validados campo a campo.
- Logs (`~/Library/Logs/app.note4me/`) registram eventos e tipos de erro, nunca conteúdo de páginas.
- Permissões Tauri mínimas (diálogos de arquivo e controle da janela). Nenhuma chamada de rede do app; imagens `https://` em páginas são carregadas pelo WebView quando exibidas.
- Os comandos de teste E2E só existem em builds de debug e exigem variável de ambiente.

## Desempenho

Medido com `cargo run --release -p note4me-core --example bench 5000` (MacBook Apple Silicon; 5.000 páginas, 30 parágrafos e 30 links cada):

| Operação | Tempo |
|---|---|
| Abrir + indexar 5.000 páginas | ~0,36 s |
| Busca de texto completo | 17–22 ms |
| Busca por tag + termo | ~2 ms |
| Ir para página (fuzzy) | ~3 ms |
| Listar pasta com 100 itens | ~0,5 ms |
| Salvar página (atômico com fsync + reindexar) | ~35 ms |
| Renomear reescrevendo 60 links em 2 páginas | ~49 ms |

O custo do salvamento é dominado pelo `fsync` (durabilidade). Pastas muito grandes na barra lateral são renderizadas em lotes de 400 itens; subpastas carregam sob demanda.

## Testes

- `crates/note4me-core`: unitários por módulo + `tests/workspace.rs` (regras de integridade: arquivo real, preservação ao abrir/salvar, metadados desconhecidos, alteração externa, conflito sem sobrescrita, índice apagado, arquivos inválidos isolados, lixeira, histórico, rascunhos, renomear/mover com links).
- `src/editor/markdown/roundtrip.test.ts`: round-trip byte a byte e semântico.
- `scripts/e2e.sh` + `src/e2e/smoke.ts`: ponta a ponta no app real. O `tauri-driver` (WebDriver) não suporta macOS, por isso o teste roda dentro da própria WebView e relata o resultado por um comando de debug.
- `scripts/tour.sh`: percorre as telas para revisão visual por capturas.
