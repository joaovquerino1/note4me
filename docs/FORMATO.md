# Formato dos arquivos

O espaço de trabalho (vault) é uma pasta comum. Tudo o que você escreve está em arquivos `.md` UTF-8 dentro dela.

```
Notas/
├── Início.md
├── Projetos.md            ← página "Projetos"
├── Projetos/              ← subpáginas de "Projetos"
│   ├── Projeto A.md
│   └── Projeto B.md
├── Estudos/               ← pasta simples (sem Estudos.md): uma seção
│   └── Rust.md
├── Anexos/                ← imagens e arquivos anexados (configurável)
│   └── diagrama.png
└── .note4me/              ← dados opcionais do app (pode ser apagado)
```

## Páginas e subpáginas

- **Uma página = um arquivo `Nome.md`.** O título exibido é o nome do arquivo; renomear o título renomeia o arquivo.
- **Subpáginas** de `Nome.md` ficam na pasta `Nome/` ao lado dele. Mover ou renomear a página leva a pasta junto.
- Uma pasta sem página homônima é uma seção simples.
- Nomes de arquivo são sanitizados para funcionar em macOS, Windows, Linux e serviços de sincronização: `/ \ : * ? " < > |` viram `-`, caracteres de controle são removidos, pontos iniciais (que ocultariam o arquivo) são retirados, o tamanho é limitado a 200 bytes e o Unicode é normalizado (NFC). Nomes repetidos recebem sufixo (`Nota 2.md`) — nunca há sobrescrita.
- Arquivos e pastas que começam com `.` são ignorados.

## Frontmatter

YAML opcional no início do arquivo, entre linhas `---` (o fechamento `...` também é aceito).

```markdown
---
id: 7f0c2a64-1d7e-4c1b-9a51-6f1a2b3c4d5e
created: 2026-10-10T10:00:00Z
tags:
  - projeto
  - trabalho
status: ativo
prazo: 2026-11-01
---

Conteúdo da página.
```

- Páginas criadas pelo app recebem apenas `id` (identificador estável, UUID v4) e `created` (RFC 3339, UTC). Pode ser desligado em Ajustes › Editor.
- `id` serve para manter o histórico de versões ligado à página mesmo quando ela é renomeada fora do app. Não é usado em links.
- O título **não** é guardado no frontmatter (o nome do arquivo é a única fonte). Não há campo `updated`: a data de modificação do arquivo é usada, para não gerar diferenças a cada salvamento.
- `tags` (ou `tag`) aceita lista ou texto separado por vírgulas/espaços; `#` inicial é ignorado.
- **Edição cirúrgica:** alterar uma propriedade substitui apenas as linhas daquela chave de primeiro nível. Comentários, ordem, aspas, chaves desconhecidas e estruturas complexas permanecem byte a byte. Cada edição é verificada reanalisando o YAML; se outra chave mudaria, a edição é recusada.
- Frontmatter inválido é preservado sem alterações; o corpo continua editável e as propriedades ficam bloqueadas até a correção.
- Valores escritos pelo app: texto simples sem aspas quando seguro (`status: ativo`), com aspas duplas quando ambíguo (`"123"`, `"a: b"`), datas `AAAA-MM-DD` sem aspas, listas em bloco (`  - item`).

## Corpo Markdown

CommonMark + extensões GFM: tabelas, listas de tarefas (`- [ ]`, `- [x]`), tachado (`~~`). Preservados verbatim (exibidos como "Markdown preservado"): blocos HTML e comentários, HTML em linha, referências e definições de nota de rodapé (`[^1]`), matemática (`$…$`, `$$…$$`), embeds do Obsidian (`![[…]]`).

**Fidelidade:** ao abrir, cada bloco de primeiro nível guarda o texto original. Ao salvar, blocos não modificados são gravados exatamente como estavam (espaços, marcadores `*`/`+`, títulos setext, tabelas alinhadas à mão, tudo). Somente blocos editados são reescritos no estilo convencional — veja [LIMITACOES.md](LIMITACOES.md#markdown).

BOM UTF-8 e quebras de linha CRLF são detectados e restaurados ao salvar. Arquivos que não são UTF-8 válido não são abertos para edição (para não corromper o conteúdo).

## Links

- **Padrão:** link Markdown relativo ao arquivo, com espaços codificados: `[Rust](../Estudos/Rust.md)`, `[Seção](Página.md#seção)`. Funciona no GitHub, VS Code, Obsidian, Typora e geradores de site.
- **Opcional:** `[[Página]]` / `[[Página|apelido]]` (Ajustes › Editor). Resolvido pelo nome: mesma pasta primeiro, depois o caminho mais curto.
- Ao renomear ou mover, o app reescreve os destinos (apenas os bytes do destino) em todas as páginas que apontam para o item e nos links relativos da própria página movida. Um relatório informa quantos links foram atualizados. Antes de reescrever outra página, a versão anterior vai para o histórico.
- Links para destinos inexistentes aparecem riscados e são listados no painel de informações e em Ajustes › Arquivos › Links quebrados.

## Anexos

Copiados para dentro do vault (o original não é alterado) e referenciados por caminho relativo: `![foto](../Anexos/foto.png)`. Local configurável: uma pasta do vault (padrão `Anexos/`), subpasta ao lado de cada página, ou a mesma pasta da página. Nomes são sanitizados e duplicados recebem sufixo. Limite de tamanho configurável (padrão 200 MB).

## `.note4me/` — dados opcionais

| Caminho | Conteúdo | Se apagar |
|---|---|---|
| `state.json` | favoritos, recentes, ordem manual da barra lateral, visualizações de coleções | perde essas preferências |
| `history/<chave>/<ms>.md` | versões anteriores (cópias completas do arquivo) | perde versões antigas |
| `trash/<id>/` | itens excluídos + `entry.json` com o caminho original | perde a lixeira |
| `drafts/<chave>.json` | rascunhos de salvamentos que falharam | perde rascunhos pendentes |
| `LEIA-ME.txt`, `.gitignore` | explicação; ignora history/trash/drafts no Git | nada |

Nenhum arquivo em `.note4me/` é necessário para ler o conteúdo. O índice de busca não é persistido: é reconstruído dos arquivos a cada abertura.

## Coleções (bancos de dados)

| Parte | Onde fica | Portável? |
|---|---|---|
| Registros | uma página `.md` por registro, na pasta da coleção | sim |
| Campos | propriedades do frontmatter | sim (YAML padrão) |
| Tipos | inferidos dos valores: booleano → caixa, número, `AAAA-MM-DD` → data, lista → tags, resto → texto | sim |
| Visualização (colunas, filtros, ordenação, agrupamento, layout, modelo) | `.note4me/state.json` | não — específico do note4me |

## Formato de tema

Arquivo JSON (`*.note4me-theme.json`), máx. 64 KB:

```json
{
  "format": "note4me-theme",
  "version": 1,
  "id": "meu-tema",
  "name": "Meu tema",
  "mode": "light",
  "highContrast": false,
  "colors": { "bg": "#ffffff", "surface": "#f7f7f5", "...": "..." }
}
```

`colors` deve conter exatamente as 22 chaves: `bg, surface, raised, hover, active, border, borderStrong, text, textSecondary, textMuted, accent, accentText, link, focus, selection, codeBg, codeText, danger, warning, success, highlight, shadow`, com valores `#rgb`, `#rrggbb` ou `#rrggbbaa`. A importação rejeita chaves desconhecidas, valores que não sejam cores e ids de temas embutidos, e informa as combinações abaixo do contraste WCAG (texto 4,5:1; 7:1 em temas de alto contraste).

## Preferências do app

`~/Library/Application Support/app.note4me/settings.json` (e `themes/` para temas personalizados). Nunca ficam no vault.
