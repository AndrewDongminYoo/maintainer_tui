import { useTheme } from "@/hooks/use-theme";

export interface GitStatusProps {
  branch: string;
  status: string;
  branchId?: string;
}

/** Compact two-line working-copy summary, shaped after termcn's GitStatus component. */
export const GitStatus = ({ branch, status, branchId }: GitStatusProps) => {
  const theme = useTheme();

  return (
    <box height={2} flexDirection="column">
      <text
        id={branchId}
        selectable={Boolean(branchId)}
        fg={theme.colors.primary}
        truncate
        wrapMode="none"
      >
        <b>{"Branch "}</b>
        {branch}
      </text>
      <text selectable={false} fg={theme.colors.mutedForeground} truncate wrapMode="none">
        {status}
      </text>
    </box>
  );
};
