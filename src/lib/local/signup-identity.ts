// Reads and validates the identity half of a signup (or of the Google
// "Complete your account" step) from a request body. The rules themselves live
// in the cores — phone-core, host-verification-core, id-change-core — and the
// requirement in signup-identity-core; this only runs them field by field so
// both routes answer with the same per-field `fields` map the host
// application uses.
import { normalizePhone } from './phone-core'
import { isIdDocumentImage, normalizeDocType, type DocType } from './host-verification-core'
import { normalizeDocumentNumber } from './id-change-core'
import { PHONE_TAKEN_MESSAGE } from './signup-identity-core'
import { phoneTakenByOther } from './auth'

export interface SignupIdentity {
  phone: string
  docType: DocType
  idNumber: string
  idFront: string
  idBack: string
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/**
 * `{ identity }` when every field is good, else `{ fields }` keyed like the
 * request body (`phone`, `doc_type`, `id_number`, `id_front`, `id_back`).
 * `email` is the account's own address, so a re-signup keeps its own number.
 */
export async function readSignupIdentity(
  b: Record<string, unknown>,
  email: string
): Promise<{ identity: SignupIdentity; fields?: undefined } | { identity?: undefined; fields: Record<string, string> }> {
  const fields: Record<string, string> = {}

  const rawPhone = str(b.phone)
  const phone = normalizePhone(rawPhone)
  if (!rawPhone) fields.phone = 'Phone number is required'
  else if (!phone) fields.phone = 'Enter a valid phone number, like 010 1234 5678'
  else if (await phoneTakenByOther(phone, email)) fields.phone = PHONE_TAKEN_MESSAGE

  let docType: DocType | null = null
  try {
    docType = normalizeDocType(b.doc_type ?? b.docType)
  } catch (e) {
    fields.doc_type = e instanceof Error ? e.message : 'Please choose which document you are uploading'
  }

  let idNumber = ''
  try {
    idNumber = normalizeDocumentNumber(b.id_number ?? b.idNumber, docType ?? undefined)
  } catch (e) {
    fields.id_number = e instanceof Error ? e.message : 'Please enter the number on your document'
  }

  const idFront = str(b.id_front ?? b.idFront)
  const idBack = str(b.id_back ?? b.idBack)
  if (!isIdDocumentImage(idFront)) fields.id_front = 'A photo of the front of your ID is required'
  if (!isIdDocumentImage(idBack)) fields.id_back = 'A photo of the back of your ID is required'

  if (Object.keys(fields).length || !phone || !docType) return { fields }
  return { identity: { phone, docType, idNumber, idFront, idBack } }
}
