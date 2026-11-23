// The meeting point of a test that races runs (gamma-p3-020): each caller waits until `count` of them
// arrived, so that their transactions are all open before the commands they then call race.
export function together(count: number): () => Promise<void> {
  let arrived = 0;
  let release = () => {};
  const met = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived === count) release();
    return met;
  };
}
