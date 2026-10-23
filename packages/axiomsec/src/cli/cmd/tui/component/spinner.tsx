import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import type { JSX } from "@opentui/solid"
import type { ColorInput, RGBA } from "@opentui/core"
import type { ColorGenerator } from "../ui/spinner"

/**
 * The lifecycle phase the spinner is signalling. Each phase gets its own
 * glyph family + tempo so the user reads the *meaning* of the wait, not
 * just "something is happening".
 */
export type SpinnerPhase =
  | "connecting"
  | "waiting_for_model"
  | "streaming"
  | "tool"
  | "finalizing"
  | "preparing"
  | "default"

/**
 * Per-phase glyph families.
 *
 * Design notes:
 *  - `connecting`: clock-fill arc → "establishing"
 *  - `waiting_for_model`: dense braille block stepping → "remote brain crunching"
 *  - `streaming`: filling/draining vertical block → "data flowing"
 *  - `tool`: classic 10-frame braille spinner (the existing default) → "local work"
 *  - `finalizing`: diamond pulse → "wrapping up"
 *  - `preparing`: sparse single-dot orbit → "warming up"
 *  - `default`: same braille as `tool`, kept for backwards compatibility
 */
const PHASE_FRAMES: Record<SpinnerPhase, { frames: string[]; interval: number }> = {
  connecting: {
    frames: ["◌", "◐", "◑", "◒", "◓", "◔", "◕", "●"],
    interval: 110,
  },
  waiting_for_model: {
    frames: ["⢿", "⣻", "⣽", "⣾", "⣷", "⣯", "⣟", "⡿"],
    interval: 100,
  },
  streaming: {
    frames: ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█", "▉", "▊", "▋", "▌", "▍", "▎"],
    interval: 70,
  },
  tool: {
    frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    interval: 80,
  },
  finalizing: {
    frames: ["◇", "◈", "◆", "◈"],
    interval: 130,
  },
  preparing: {
    frames: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
    interval: 110,
  },
  default: {
    frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    interval: 80,
  },
}

export function spinnerFramesFor(phase?: SpinnerPhase) {
  return PHASE_FRAMES[phase ?? "default"]
}

export function SpinnerGlyph(props: { frames: string[]; interval: number; color: RGBA | ColorGenerator }) {
  const [index, setIndex] = createSignal(0)
  createEffect(() => {
    setIndex(0)
    const timer = setInterval(
      () => setIndex((value) => (value + 1) % Math.max(1, props.frames.length)),
      props.interval,
    )
    onCleanup(() => clearInterval(timer))
  })
  const chars = () => Array.from(props.frames[index()] ?? "")
  const colorAt = (charIndex: number): ColorInput =>
    typeof props.color === "function" ? props.color(index(), charIndex, props.frames.length, chars().length) : props.color
  return (
    <box flexDirection="row">
      {chars().map((char, charIndex) => (
        <text fg={colorAt(charIndex)}>{char}</text>
      ))}
    </box>
  )
}

export function Spinner(props: { children?: JSX.Element; color?: RGBA; phase?: SpinnerPhase }) {
  const { theme } = useTheme()
  const kv = useKV()
  const color = () => props.color ?? theme.textMuted
  const def = () => spinnerFramesFor(props.phase)
  return (
    <Show when={kv.get("animations_enabled", true)} fallback={<text fg={color()}>⋯ {props.children}</text>}>
      <box flexDirection="row" gap={1}>
        <SpinnerGlyph frames={def().frames} interval={def().interval} color={color()} />
        <Show when={props.children}>
          <text fg={color()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}
