# note4me

Aplicativo de notas e organização do conhecimento para macOS em que **cada página é um arquivo Markdown real** numa pasta escolhida por você. Organize páginas, subpáginas, links, backlinks e coleções (estilo banco de dados) — e continue podendo abrir, editar, copiar, versionar e sincronizar os arquivos com qualquer outra ferramenta.

- **Markdown é a fonte da verdade.** Não existe banco de dados com o conteúdo. O índice de busca é reconstruído a partir dos arquivos.
- **Nada é sobrescrito em silêncio.** Gravação atômica, detecção de alterações externas, conflitos resolvidos pelo usuário, histórico de versões e lixeira recuperável.
- **Abrir e salvar não reformata.** Blocos que você não editou são gravados byte a byte como estavam.
- **Aparência nunca toca os arquivos.** 12 temas, tipografia por área, escala da interface e acessibilidade ficam nas preferências do app.

## Funcionalidades

| Área | O que existe |
|---|---|
| Editor | Parágrafos, títulos, listas, listas numeradas, tarefas, citações, código com destaque, divisores, tabelas (com alinhamento), imagens, links externos e internos, negrito/itálico/tachado/código, menu `/`, sugestão de páginas com `[[`, barra de formatação, ⌘K para links, desfazer/refazer, colar imagens, arrastar arquivos do Finder |
| Páginas | Criar, renomear (inclusive pelo título), duplicar, mover (menu ou arrastar), reordenar, excluir para a lixeira e restaurar; subpáginas; favoritos; recentes; histórico de navegação; breadcrumbs |
| Links | Links Markdown relativos (padrão) ou `[[wiki]]`; reescrita automática ao renomear/mover; backlinks com contexto; detecção de links quebrados |
| Busca | Títulos, conteúdo, tags, propriedades e nomes de arquivo; ignora maiúsculas e acentos; `"frase"`, `tag:x`, `path:Pasta`; filtros de pasta, tag e data; trechos destacados; ⌘P para ir a uma página |
| Coleções | Qualquer pasta vira tabela/lista: colunas do frontmatter, tipos inferidos (texto, número, data, caixa, tags), filtros, ordenação, agrupamento, subpastas, edição de células, modelo de novas entradas |
| Segurança de dados | Escrita atômica com `fsync`, conflitos (comparar / manter a minha / usar a do disco / salvar como cópia), rascunhos de recuperação, histórico com diff e restauração, lixeira, preservação de BOM, CRLF e frontmatter desconhecido |
| Importar/exportar | Importar arquivos ou pastas Markdown (sem sobrescrever, com relatório); exportar página com anexos (links reescritos); exportar o espaço de trabalho inteiro |
| Aparência | 6 temas claros + 6 escuros, seguir o macOS, temas personalizados com editor e verificação de contraste WCAG, importação/exportação de temas, densidade, efeitos |
| Tipografia | Fontes por área (interface, conteúdo, títulos, código) verificadas em tempo de execução, tamanho, peso, altura de linha, espaçamentos, largura de leitura, alinhamento, tamanho em tabelas e código, 8 presets editáveis |
| Acessibilidade | Escala da interface 80–200%, reduzir movimento e alto contraste (manual ou seguindo o macOS), foco reforçado, sublinhar links, navegação completa por teclado, papéis/rótulos ARIA |

## Requisitos

- macOS 13 (Ventura) ou mais recente, Apple Silicon ou Intel.
- Para desenvolver: Rust ≥ 1.85, Xcode Command Line Tools e **Deno 2** (usado como runtime npm; Node/npm também funcionam com o mesmo `package.json`).

## Desenvolvimento

```bash
deno install
```

```bash
deno task tauri dev
```

O primeiro comando instala as dependências do frontend; o segundo abre o app com recarga automática.

## Testes e verificações

```bash
cargo test --workspace
```

```bash
deno task test
```

```bash
./scripts/e2e.sh
```

```bash
cargo clippy --workspace --all-targets && cargo fmt --all --check && deno task typecheck
```

- `cargo test`: 77 testes do núcleo (unitários e de integração: caminhos, E/S atômica, frontmatter, links, índice/busca, histórico, lixeira, anexos, importação/exportação, coleções, temas, preferências e as regras de integridade Markdown).
- `deno task test`: 23 testes de round-trip Markdown ↔ editor.
- `scripts/e2e.sh`: teste de ponta a ponta **dentro do app real** (WebView + backend Rust + arquivos reais): autosave, alteração externa, conflito sem sobrescrita, histórico, renomear com links, teclado na árvore, escala 200%, menu `/`, lixeira, reindexação, tema/tipografia sem tocar arquivos. Usa uma configuração e um espaço de trabalho temporários.
- Desempenho: `cargo run --release -p note4me-core --example bench 5000` (resultados em [docs/ARQUITETURA.md](docs/ARQUITETURA.md#desempenho)).

## Compilar o aplicativo

```bash
deno task tauri build --bundles app
```

Gera `target/release/bundle/macos/note4me.app`. Use `--bundles app,dmg` para também gerar o `.dmg`. Assinatura e notarização: [docs/DISTRIBUICAO.md](docs/DISTRIBUICAO.md).

## Estrutura do repositório

```
crates/note4me-core/   Núcleo em Rust, sem dependência de UI (toda a lógica de arquivos)
src-tauri/             Casca desktop: comandos IPC, watcher, menus, fontes do sistema
src/                   Interface React + TypeScript (apresentação e interação)
  editor/              TipTap/ProseMirror + conversor Markdown com preservação de origem
  components/          Barra lateral, página, coleções, ajustes, busca, histórico…
  e2e/                 Teste de ponta a ponta (só em builds de debug)
scripts/               e2e.sh e tour.sh (capturas de tela)
docs/                  Arquitetura, formato dos arquivos, limitações, distribuição
```

## Documentação

- [Formato dos arquivos](docs/FORMATO.md) — estrutura de pastas, frontmatter, links, anexos, `.note4me/`, coleções, formato de tema; o que é Markdown puro e o que depende do app.
- [Arquitetura e decisões](docs/ARQUITETURA.md) — stack, módulos, armazenamento, índice, conflitos, desempenho, segurança.
- [Guia de uso](docs/USO.md) — temas, tipografia, acessibilidade, atalhos, backup e recuperação.
- [Limitações conhecidas](docs/LIMITACOES.md)
- [Distribuição](docs/DISTRIBUICAO.md)

## Licença

MIT. Dependências principais: Tauri (MIT/Apache-2.0), TipTap/ProseMirror (MIT), markdown-it (MIT), pulldown-cmark (MIT), React (MIT), lucide (ISC).
