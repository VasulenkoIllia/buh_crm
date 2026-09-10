/**
 * **Did a reorder move anything?** Reads the order, runs the move, reads it again, and compares.
 *
 * A drag that lands where it started is a legal write and not an act — the pipeline's stages and
 * the service catalog both follow that rule, and it was written out by hand in each before this
 * (review, 2026-09-10). Pass the lightest ordered read there is: only the ids are compared.
 */
export async function reorder<T extends { id: string }>(
  read: () => Promise<T[]>,
  move: () => Promise<unknown>,
): Promise<{ moved: boolean; after: T[] }> {
  const before = (await read()).map((row) => row.id).join();
  await move();
  const after = await read();
  return { moved: before !== after.map((row) => row.id).join(), after };
}
