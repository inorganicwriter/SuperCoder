/**
 * 品牌标识。素材来自 assets/SuperCoder.svg（折叠丝带），内联成组件而不是 `<img src>`：
 * 一来不受 CSP 的 img-src 约束，二来在离线打包里也少一次请求。
 */

export function Logo(props: { readonly size?: number }): React.JSX.Element {
  const size = props.size ?? 26;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 585 630"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="sc-ribbon-top" x1="10%" y1="85%" x2="90%" y2="15%">
          <stop offset="0%" stopColor="#242527" />
          <stop offset="55%" stopColor="#2c2e31" />
          <stop offset="85%" stopColor="#36383c" />
          <stop offset="100%" stopColor="#5c5e62" />
        </linearGradient>
        <linearGradient id="sc-ribbon-bottom" x1="12%" y1="88%" x2="88%" y2="20%">
          <stop offset="0%" stopColor="#7c7e82" />
          <stop offset="18%" stopColor="#323437" />
          <stop offset="60%" stopColor="#232426" />
          <stop offset="100%" stopColor="#1b1c1e" />
        </linearGradient>
        <linearGradient id="sc-ribbon-fold" x1="0%" y1="45%" x2="100%" y2="55%">
          <stop offset="0%" stopColor="#e3e3e1" />
          <stop offset="40%" stopColor="#cfcfcd" />
          <stop offset="75%" stopColor="#969799" />
          <stop offset="100%" stopColor="#525356" />
        </linearGradient>
      </defs>
      <path
        d="M 227 379 C 192 355, 196 292, 265 259 C 305 258, 332 260, 357 266 C 396 286, 395 348, 312 386 C 278 386, 250 384, 227 379 Z"
        fill="url(#sc-ribbon-fold)"
      />
      <path
        d="M 227 379 L 96 319 C 46 294, 45 212, 99 177 L 314 48 C 344 30, 368 29, 396 48 L 501 116 L 265 259 C 195 292, 192 355, 227 379 Z"
        fill="url(#sc-ribbon-top)"
      />
      <path
        d="M 357 266 L 490 326 C 542 350, 543 428, 498 457 L 286 584 C 256 601, 232 599, 204 582 L 97 512 L 312 386 C 395 348, 396 286, 357 266 Z"
        fill="url(#sc-ribbon-bottom)"
      />
    </svg>
  );
}
