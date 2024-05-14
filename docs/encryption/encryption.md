# Encryption System README

## Overview

This document outlines the key components and processes of our encryption system designed for secure document handling. It covers RSA key generation, key storage, document encryption, and decryption mechanisms using Web3 wallet integrations.

## Key Generation

### Generating RSA Key Pairs

RSA key pairs are generated in the front end for each user using the following function:

```javascript
export async function generateKeyPair() {
  try {
    const keyPair = await window.crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: { name: "SHA-256" },
      },
      true,
      ["encrypt", "decrypt"]
    );
    console.log("RSA key pair generated.");
    return keyPair;
  } catch (error) {
    console.error("Error generating RSA key pair:", error);
  }
}
```

### Exporting Keys to PEM Format

Public and private keys are exported to PEM format using the following functions:

```javascript
// Export RSA public key
export async function exportPublicKey(key: CryptoKey) {
  /* Implementation omitted for brevity */
}

// Export RSA private key
export async function exportPrivateKey(key: CryptoKey) {
  /* Implementation omitted for brevity */
}
```

## Key Storage

- **Private Key Encryption**: The private key is encrypted with the user's Web3 wallet signature of a randomly generated salt derived from the user's wallet public key.
- **Data Storage**: Both the public RSA key and the encrypted private key are stored in a database along with the salt.
- **User Object**: Salt, public RSA key, and encrypted private key are stored in the user object and returned to the front end upon login.

## Document Encryption

Documents are encrypted on the backend using a random symetric master key which is then being encrypted with a set of public keys (user's public key and admin public keys) generating an encrypted version of th masterKey wich can be recovered in order to decrypt the file bytes using the user private rsa key. Here is an example of how the encryption process might look:

```javascript
import { AsymetricCrypto } from "@/asymetric-crypto/rsa";
import { SymetricCrypto } from "@/symetric-crypto";
import { getBytesFromPdf } from "@/utils/get-pdf-bytes";
import { randomBytes } from "crypto";
import NodeRSA from "node-rsa";
import { EXAMPLE_RSA_PRIVATE_KEY, PDF_FILE_NAME } from "@/constants";

export async function encryptDocumentsWithPublicKeys() {
  const rsaOne = new NodeRSA(EXAMPLE_RSA_PRIVATE_KEY);
  const rsaTwo = new NodeRSA({ b: 512 });
  const rsaThree = new NodeRSA({ b: 512 });

  const firstPrivateKey = rsaOne.exportKey("pkcs1-private-pem");
  const allPublicKeys = [rsaOne, rsaTwo, rsaThree].map((rsa) =>
    rsa.exportKey("pkcs8-public-pem")
  );

  const asymC = new AsymetricCrypto();

  //Choose a random symetric master key to encrypt the data with
  const _randomBytes = randomBytes(32).toString("hex");

  //Initialize the SymetricCrypto class with the symetric master key
  const symC = new SymetricCrypto(_randomBytes);
  const pdfBytes: Buffer = await getBytesFromPdf(PDF_FILE_NAME);
  // const encryptedData = symC.encrypt(pdfBytes.toString("base64"));

  const message: string = pdfBytes.toString("base64");

  //Encrypt the message with the symetric master key
  const encryptedData = symC.encrypt(message);

  const encryptedMasterKeys = allPublicKeys.map((publicKey) => {
    return {
      publicKey: publicKey,
      encryptedMasterKey: asymC.encryptWithPublicKey(publicKey, _randomBytes),
    };
  });

  //You can then find your public key and decrypt the master key with your private key
  return {
    encryptedData,
    encryptedMasterKeys,
    docType: "pdf",
    encoding: "base64" as BufferEncoding,
  };
}

```

## Document Decryption

Users can decrypt the encrypted document using their private RSA key, which is decrypted in the front-end using the salt and a wallet signature.

```javascript
import { encryptDocumentsWithPublicKeys } from "./1-encrypt-document-with-public-keys";
import { EXAMPLE_RSA_PRIVATE_KEY, EXAMPLE_RSA_PUBLIC_KEY } from "@/constants";
import { AsymetricCrypto } from "@/asymetric-crypto/rsa";
import { SymetricCrypto } from "@/symetric-crypto";
import * as fs from "fs";

async function decryptDocumentWithPrivateKey() {
  const { encryptedData, encryptedMasterKeys, docType, encoding } =
    await encryptDocumentsWithPublicKeys();
  const myEncryptedMasterKey = encryptedMasterKeys.find(
    (publicKeyAndEncryptedMasterKey) =>
      publicKeyAndEncryptedMasterKey.publicKey === EXAMPLE_RSA_PUBLIC_KEY
  );
  if (!myEncryptedMasterKey)
    throw new Error("Could not find my encrypted master key");
  const asymC = new AsymetricCrypto(EXAMPLE_RSA_PRIVATE_KEY);
  const myMasterKey = asymC.decrypt(myEncryptedMasterKey.encryptedMasterKey);
  const symC = new SymetricCrypto(myMasterKey);
  const decryptedData = symC.decrypt(encryptedData);
  //save it as a pdf
  fs.writeFileSync(
    `decrypted.${docType}`,
    Buffer.from(decryptedData, encoding)
  );
}
```

## Secure Signature Storage

To avoid requiring the user to sign with their wallet every time they need to decrypt a document, we implement a secure way to cache the signature in local storage. The signature used for decrypting the private RSA key is encrypted with a 4-digit code set by the user. This code is not stored anywhere but is used instantly in function memory.
