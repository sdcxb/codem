# Third-Party Software Notices

This file contains attribution notices for third-party software integrated into Codem.

---

## Petdex

- **Project**: Petdex (Desktop Pet Marketplace)
- **Repository**: https://github.com/crafter-station/petdex
- **License**: MIT License
- **Copyright**: (c) Petdex Contributors

### MIT License

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Integration Description

Codem integrates Petdex's pet package format and public manifest API:

1. **Pet Package Format** (`pet.json` + `spritesheet`): Codem adopts Petdex's
   open pet package format for representing pet metadata and sprite animations.
   The type definitions (`PetDefinition`, `PetAnimationFrame`) are designed to
   be compatible with Petdex's format specification.

2. **Manifest API**: Codem fetches the public pet catalog from Petdex's
   manifest API endpoint (`https://petdex.dev/api/manifest`) to allow users
   to browse and download pets from the Petdex marketplace.

3. **Based on Petdex**: Codem's pet system (`src/core/pet/`,
   `src/components/Pet*.tsx`) is based on the Petdex open-source project and
   adapted for Codem's architecture. The integration includes calling Petdex's
   public marketplace API, adopting its pet package format, and modifying
   the implementation to fit Codem's Agent event model.

### Attribution

This product includes software developed by the Petdex project
(https://github.com/crafter-station/petdex).
