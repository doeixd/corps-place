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
          title: 'group-[.toast]:text-sm group-[.toast]:font-medium group-[.toast]:text-text-primary',
          description: 'group-[.toast]:text-text-secondary',
          actionButton:
            'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground group-[.toast]:rounded-md group-[.toast]:h-7 group-[.toast]:px-2.5 group-[.toast]:text-xs group-[.toast]:font-medium group-[.toast]:hover:bg-primary/90',
          cancelButton:
            'group-[.toast]:bg-muted group-[.toast]:text-text-secondary group-[.toast]:rounded-md group-[.toast]:h-7 group-[.toast]:px-2.5 group-[.toast]:text-xs group-[.toast]:font-medium',
        },
      }}
      {...props}
    />
  );
}
