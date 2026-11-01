declare module 'proper-lockfile' {
  const lockfile: {
    lock(path: string, options: {
      lockfilePath: string; stale: number; update: number;
      retries: { retries: number; minTimeout: number; maxTimeout: number; factor: number };
      onCompromised(error: Error): void;
    }): Promise<() => Promise<void>>
  }
  export default lockfile
}
