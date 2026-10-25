import { cn } from "@/components/lib/utils.js";

// pi-zcode: PI 品牌图形（描边 π），与 build/icon-pi.svg 的应用图标同一笔画。
// 组件名保留 ZCodeAboutLogo/ZCodeWordmarkLogo（调用点多，改名是纯磨工），只换图形本体。
export function ZCodeAboutLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="100"
      height="100"
      fill="none"
      viewBox="0 0 1024 1024"
      className={cn("shrink-0 text-current", className)}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M232 340 H792" stroke="currentColor" strokeWidth="64" strokeLinecap="round" fill="none" />
      <path d="M356 340 V688" stroke="currentColor" strokeWidth="64" strokeLinecap="round" fill="none" />
      <path d="M636 340 V620 Q636 712 726 712" stroke="currentColor" strokeWidth="64" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function ZCodeWordmarkLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="132"
      height="54"
      viewBox="0 0 560 220"
      fill="none"
      className={cn("shrink-0 text-current", className)}
      aria-hidden="true"
      focusable="false"
    >
      <g transform="translate(0, 10) scale(0.195)">
        <path d="M232 340 H792" stroke="currentColor" strokeWidth="72" strokeLinecap="round" fill="none" />
        <path d="M356 340 V688" stroke="currentColor" strokeWidth="72" strokeLinecap="round" fill="none" />
        <path d="M636 340 V620 Q636 712 726 712" stroke="currentColor" strokeWidth="72" strokeLinecap="round" fill="none" />
      </g>
      <text
        x="230"
        y="168"
        fill="currentColor"
        fontSize="180"
        fontWeight="600"
        fontFamily="system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif"
        letterSpacing="6"
      >
        PI
      </text>
    </svg>
  );
}
