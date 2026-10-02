import { QRCodeSVG } from 'qrcode.react'

interface InvitationQrProps {
  link: string
  label: string
  instruction: string
}

export default function InvitationQr({ link, label, instruction }: InvitationQrProps) {
  return <figure className="invitation-qr">
    <QRCodeSVG value={link} size={208} level="M" marginSize={4} role="img" aria-label={label} title={label} />
    <figcaption>{instruction}</figcaption>
  </figure>
}
