import type { BusinessContext } from '../lib/contracts';
import type { AccountClientError } from '../lib/account';
import ProfileImageEditor from './ProfileImageEditor';
import './business-profile.css';

export default function AccountProfileSettings({ business, operatorToken, accountName, onSaved, onSessionError }: {
  business: BusinessContext; operatorToken: string; accountName: string; onSaved: (business: BusinessContext) => void; onSessionError?: (error: AccountClientError) => void;
}) {
  return <section className="management-shell management-polish account-profile-settings">
    <h1>Mi cuenta</h1>
    <ProfileImageEditor business={business} operatorToken={operatorToken} subject="account" name={accountName} onSaved={onSaved} onSessionError={onSessionError} />
    <p className="text-sm text-muted">{accountName}</p>
  </section>;
}
