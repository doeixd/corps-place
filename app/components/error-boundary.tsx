import { Component, type ReactNode } from 'react';
import { StatusCard } from '@/components/status-card';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
  /** Custom fallback. Receives `reset()` to retry rendering the subtree. */
  fallback?: (reset: () => void) => ReactNode;
  /** Short label used in the default fallback copy and console logging. */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches render/runtime errors in a subtree so one broken widget degrades to a
 * compact, retryable message instead of blanking the whole page. Wrap risky
 * sections (rich-text editors, tab panels, third-party widgets, anything driven
 * by external data) so a localized failure stays localized.
 *
 * Give it a changing `key` (e.g. the active tab) to auto-reset when the content
 * it guards is swapped out.
 */
export class SectionErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // The app keeps running; surface the detail for debugging.
    console.error(`[${this.props.label ?? 'section'}] render error:`, error);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.reset);
    return (
      <StatusCard
        tone="error"
        title="This section couldn't load"
        description={
          this.props.label
            ? `Something went wrong in ${this.props.label}. You can try again.`
            : 'Something went wrong here. You can try again.'
        }
        action={
          <Button variant="outline" size="sm" onClick={this.reset}>
            Try again
          </Button>
        }
      />
    );
  }
}
