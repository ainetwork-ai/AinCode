import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M12 16H4V8H12V16Z" fill="var(--icon-weak-base)" />
      <path data-slot="logo-logo-mark-o" d="M12 4H4V16H12V4ZM16 20H0V0H16V20Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M60 80H20V40H60V80Z" fill="var(--icon-base)" />
      <path d="M60 20H20V80H60V20ZM80 100H0V0H80V100Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 186 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        <path d="M18 30H6V24H18V30Z" fill="var(--icon-weak-base)" />
        <path d="M18 24H6V30H18V24ZM24 36H0V18H18V12H0V6H24V36Z" fill="var(--icon-base)" />
        <path d="M36 36H30V12H36V36ZM36 6H30V0H36V6Z" fill="var(--icon-base)" />
        <path d="M60 36H48V18H60V36Z" fill="var(--icon-weak-base)" />
        <path d="M60 12H48V36H42V6H60V12ZM66 36H60V12H66V36Z" fill="var(--icon-base)" />
        <path d="M96 30H78V18H96V30Z" fill="var(--icon-weak-base)" />
        <path d="M96 12H78V30H96V36H72V6H96V12Z" fill="var(--icon-strong-base)" />
        <path d="M120 30H108V18H120V30Z" fill="var(--icon-weak-base)" />
        <path d="M120 12H108V30H120V12ZM126 36H102V6H126V36Z" fill="var(--icon-strong-base)" />
        <path d="M150 30H138V18H150V30Z" fill="var(--icon-weak-base)" />
        <path d="M150 12H138V30H150V12ZM156 36H132V6H150V0H156V36Z" fill="var(--icon-strong-base)" />
        <path d="M186 24V30H168V24H186Z" fill="var(--icon-weak-base)" />
        <path d="M168 12V18H180V12H168ZM186 24H168V30H186V36H162V6H186V24Z" fill="var(--icon-strong-base)" />
      </g>
    </svg>
  )
}
