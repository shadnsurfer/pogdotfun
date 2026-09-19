/** Public-only routing. Execution workers have no browser-accessible console. */
export function getDomainRouting(_hostname: string) {
  return {
    isAdminHost: false,
    publicHref: (path: string) => path,
    redirectFor(_pathname: string, _search = '', _hash = ''): string | null {
      return null;
    },
  };
}
