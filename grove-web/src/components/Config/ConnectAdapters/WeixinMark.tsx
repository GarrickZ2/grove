import wechatLogo from './assets/wechat.svg';

export function WeixinMark({ size }: { size: number }) {
  return <div className="flex shrink-0 items-center justify-center" style={{ width: size + 12, height: size + 12 }}><img src={wechatLogo} alt="" width={size} height={size} /></div>;
}
