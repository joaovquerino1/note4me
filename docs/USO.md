# Guia de uso

## Primeiros passos

Na primeira abertura, escolha uma pasta existente (por exemplo uma pasta do Obsidian, de notas em Markdown ou do iCloud Drive) ou crie um novo espaço de trabalho. A pasta é lembrada nas próximas aberturas; troque em Ajustes › Arquivos ou pelo menu do nome do espaço de trabalho na barra lateral.

## Escrevendo

- Digite `/` para inserir blocos; `[[` para criar um link para outra página (ou criar uma nova).
- Selecione texto para a barra de formatação; ⌘K insere ou edita links.
- Clique num link para segui-lo; ⌥+clique posiciona o cursor dentro dele.
- Cole imagens ou arraste arquivos do Finder para a página: eles são copiados para a pasta de anexos.
- O estado do salvamento aparece no canto superior direito: Salvo, Alterações não salvas, Salvando…, Conflito, Erro.

## Organizando

- Arraste páginas na barra lateral: no meio de uma página → vira subpágina; acima/abaixo → reordena; sobre uma pasta → move.
- Clique direito (ou ⋯) para renomear, duplicar, mover, favoritar, exportar ou excluir.
- Pastas e páginas com subpáginas podem ser vistas como **coleção** (tabela ou lista das propriedades).
- Arrastar arquivos do Finder para a barra lateral os importa (copia) para o espaço de trabalho.

## Temas

Ajustes › Aparência: modo (seguir o macOS, claro, escuro), um tema claro e um escuro (usados conforme o modo), densidade, barra lateral e efeitos. "Personalizar tema atual…" abre o editor de cores com pré-visualização e verificação de contraste; temas podem ser exportados e importados como JSON.

## Tipografia

Ajustes › Tipografia: escolha um preset como ponto de partida e ajuste fontes (interface, conteúdo, títulos, código), tamanho, pesos, altura de linha, espaçamentos, largura da coluna, alinhamento e tamanhos em tabelas e código. Só fontes realmente instaladas aparecem; se uma fonte escolhida não existir, o app avisa e usa uma alternativa. ⌘+ / ⌘− / ⌘0 ajustam o tamanho do texto.

## Acessibilidade

Ajustes › Acessibilidade: escala da interface (80–200%, independente do tamanho do texto), reduzir movimento e alto contraste (manual ou seguindo o macOS), foco reforçado e links sublinhados. Todo o app pode ser usado pelo teclado — ⌘/ mostra os atalhos.

## Backup e recuperação

- **Backup:** copie a pasta do espaço de trabalho (Time Machine, iCloud Drive, Git, rsync…). Ela contém tudo. `.note4me/` é opcional (histórico, lixeira e preferências da barra lateral).
- **Versões anteriores:** menu ⋯ › Histórico de versões (⌥⌘H) — compare e restaure; a versão atual é guardada antes.
- **Exclusões:** Lixeira na barra lateral — restaure ou exclua permanentemente.
- **Conflitos:** se um arquivo mudar fora do app enquanto você edita, nada é sobrescrito; escolha comparar, manter a sua, usar a do disco ou salvar a sua como cópia.
- **Salvamento que falhou** (disco cheio, volume desconectado, permissão): o texto fica num rascunho de recuperação e o app tenta novamente; ao reabrir a página você pode restaurá-lo.
- **Índice desatualizado:** Ajustes › Arquivos › Reindexar agora. Apagar `.note4me/` não afeta nenhuma página.
- **Usando com Git:** o `.note4me/.gitignore` já ignora histórico, lixeira e rascunhos.
