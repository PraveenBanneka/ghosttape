| Test | ESP32 radio ON | ESP32 radio OFF | MT19937 | PCG64 | os.urandom | RANDU |
|---|---|---|---|---|---|---|
| Byte chi-square | **PASS** chi2=269 p=0.258 | **PASS** chi2=285 p=0.093 | **PASS** chi2=241 p=0.727 | **PASS** chi2=275 p=0.181 | **PASS** chi2=295 p=0.044 | **PASS** chi2=286 p=0.086 |
| Shannon entropy | **PASS** 7.999981 bit | **PASS** 7.999980 bit | **PASS** 7.999983 bit | **PASS** 7.999981 bit | **PASS** 7.999980 bit | **PASS** 7.999980 bit |
| Serial correlation | **PASS** r=+0.00046 p=0.137 | **PASS** r=-0.00029 p=0.352 | **PASS** r=-0.00035 p=0.263 | **PASS** r=+0.00002 p=0.944 | **PASS** r=+0.00038 p=0.215 | **PASS** r=-0.00006 p=0.833 |
| Monte-Carlo pi | **PASS** 3.14261 p=0.413 | **PASS** 3.14273 p=0.359 | **PASS** 3.14098 p=0.622 | **PASS** 3.14418 p=0.037 | **PASS** 3.14240 p=0.513 | **PASS** 3.14102 p=0.642 |
| NIST frequency | **PASS** p=0.750 10/10 | **PASS** p=0.396 10/10 | **PASS** p=0.087 10/10 | **PASS** p=0.959 10/10 | **PASS** p=0.628 10/10 | **PASS** p=0.390 10/10 |
| NIST block frequency | **PASS** p=0.185 10/10 | **PASS** p=0.367 10/10 | **PASS** p=0.707 10/10 | **PASS** p=0.563 10/10 | **PASS** p=0.312 10/10 | **PASS** p=0.372 10/10 |
| NIST runs | **PASS** p=0.577 10/10 | **PASS** p=0.838 10/10 | **PASS** p=0.586 10/10 | **PASS** p=0.801 10/10 | **PASS** p=0.539 10/10 | **PASS** p=0.879 10/10 |
| NIST approximate entropy | **PASS** p=0.263 10/10 | **PASS** p=0.397 10/10 | **PASS** p=0.396 10/10 | **PASS** p=0.185 10/10 | **PASS** p=0.095 10/10 | **PASS** p=0.516 10/10 |
| Autocorrelation 1-32 | **PASS** max abs r=0.00072 p=0.640 | **PASS** max abs r=0.00090 p=0.109 | **PASS** max abs r=0.00054 p=1.000 | **PASS** max abs r=0.00099 p=0.044 | **PASS** max abs r=0.00061 p=1.000 | **PASS** max abs r=0.00098 p=0.049 |
| 3D triples chi-square | **PASS** chi2=4117 p=0.402 | **PASS** chi2=4094 p=0.501 | **PASS** chi2=3994 p=0.869 | **PASS** chi2=3904 p=0.984 | **PASS** chi2=4025 p=0.781 | **FAIL** chi2=1323179 p<1e-300 |
| **Tests passed** | 10 / 10 | 10 / 10 | 10 / 10 | 10 / 10 | 10 / 10 | 9 / 10 |
