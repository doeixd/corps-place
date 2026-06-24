import { Toaster as Sonner, type ToasterProps } from 'sonner';

/**
 * App toast host (sonner). Mounted once in the root layout. `richColors` gives
 * error/success toasts their semantic colors; the theme follows the app's theme.
 */
export function Toaster({ theme = 'system', ...props }: ToasterProps) {
  return (
    <Sonner
      theme={theme}
      richColors
      position="top-center"
      toastOptions={{
        classNames: {
          toast:
            'group-[.toaster]:border-border group-[.toaster]:shadow-lg group-[.toaster]:rounded-lg',
          description: 'group-[.toast]:text-text-secondary',
        },
      }}
      {...props}
    />
  );
}
