/** tests/fixtures/read-trade-table.ts — decode the named JSON cells in a trade record table. */

export function readTradeTable(text: string): Record<string, unknown>[] {
  const lines = text.split('\n').filter((line) => line.startsWith('| '));
  const split = (line: string) =>
    line
      .slice(2, -2)
      .split(' | ')
      .map((cell) => cell.trim());
  const header = lines[0];
  if (header === undefined) return [];
  const names = split(header);
  return lines
    .slice(2)
    .map((line) =>
      Object.fromEntries(
        split(line).flatMap((cell, index) =>
          cell.length === 0 ? [] : [[names[index], JSON.parse(cell.slice(1, -1))]],
        ),
      ),
    );
}
