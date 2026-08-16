import { useTheme } from "@/hooks/use-theme";

export interface DividerProps {
  variant?: "single" | "double" | "bold";
  orientation?: "horizontal" | "vertical";
  color?: string;
  label?: string;
  labelColor?: string;
  dividerChar?: string;
  titlePadding?: number;
  padding?: number;
  height?: number;
  width?: number | "auto";
}

const DIVIDER_CHARS: Record<NonNullable<DividerProps["variant"]>, string> = {
  bold: "┃",
  double: "║",
  single: "│",
};

export const Divider = ({
  variant = "single",
  orientation = "horizontal",
  color,
  label,
  labelColor,
  dividerChar,
  titlePadding = 1,
  padding = 0,
  height = 1,
  width = "auto",
}: DividerProps) => {
  const theme = useTheme();
  const resolvedColor = color ?? theme.colors.border;
  const vChar = dividerChar ?? DIVIDER_CHARS[variant];

  if (orientation === "vertical") {
    const lines = Array.from({ length: height }, (_, i) => i);
    return (
      <box flexDirection="column">
        {lines.map((i) => (
          <text key={i} fg={resolvedColor}>
            {vChar}
          </text>
        ))}
      </box>
    );
  }

  const paddingStr = "".repeat(padding);
  const titlePad = "".repeat(titlePadding);
  // Registry code ships per-side border booleans, which OpenTUI's BoxProps does not have; it
  // takes the enabled sides as a list instead.
  const hrBox = (
    <box
      flexGrow={1}
      borderStyle="single"
      borderColor={resolvedColor}
      border={["top"]}
    />
  );

  if (label) {
    const resolvedLabelColor = labelColor ?? resolvedColor;
    return (
      <box flexDirection="row" width={width === "auto" ? undefined : width}>
        {padding > 0 && <text>{paddingStr}</text>}
        {hrBox}
        <text fg={resolvedLabelColor}>{`${titlePad}${label}${titlePad}`}</text>
        {hrBox}
        {padding > 0 && <text>{paddingStr}</text>}
      </box>
    );
  }

  return (
    <box flexDirection="row" width={width === "auto" ? undefined : width}>
      {padding > 0 && <text>{paddingStr}</text>}
      {hrBox}
      {padding > 0 && <text>{paddingStr}</text>}
    </box>
  );
};
