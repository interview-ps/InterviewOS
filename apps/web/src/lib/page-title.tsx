import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type PageTitleContextValue = {
  title: string | null;
  setTitle: (title: string | null) => void;
};

const PageTitleContext = createContext<PageTitleContextValue>({
  title: null,
  setTitle: () => {},
});

/**
 * Lets a page give the shell a descriptive name (e.g. "Coding interview ·
 * 6 Oct") so breadcrumbs never fall back to a raw route id.
 */
export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  const value = useMemo(() => ({ title, setTitle }), [title]);
  return (
    <PageTitleContext.Provider value={value}>{children}</PageTitleContext.Provider>
  );
}

export function usePageTitle(): string | null {
  return useContext(PageTitleContext).title;
}

/** Call from a page: `useSetPageTitle("Coding interview · 6 Oct")`. */
export function useSetPageTitle(title: string | null) {
  const { setTitle } = useContext(PageTitleContext);
  useEffect(() => {
    setTitle(title);
    return () => setTitle(null);
  }, [title, setTitle]);
}
