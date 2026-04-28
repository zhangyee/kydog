import { Component, type ReactNode } from 'react';

type Props = { children: ReactNode; fallbackLabel?: string };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error) { console.error('ErrorBoundary caught', error); }
  render() {
    if (this.state.error) {
      return (
        <div className="p-4 text-[color:var(--color-accent)] font-mono text-sm">
          {this.props.fallbackLabel ?? '该区域出错'}: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}
