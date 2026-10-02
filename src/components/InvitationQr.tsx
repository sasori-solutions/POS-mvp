import { QRCodeSVG } from "qrcode.react";

interface InvitationQrProps {
  link: string;
  label: string;
  instruction: string;
}

export default function InvitationQr({
  link,
  label,
  instruction,
}: InvitationQrProps) {
  return (
    <figure className="invitation-qr mb-6 flex flex-col items-center gap-3 rounded-lg border border-line bg-white p-5">
      <QRCodeSVG
        value={link}
        size={208}
        level="M"
        marginSize={4}
        role="img"
        aria-label={label}
        title={label}
      />
      <figcaption>{instruction}</figcaption>
    </figure>
  );
}
